#!/usr/bin/env node
/**
 * Bridge ekstraktor lokal untuk Ambil.
 *
 * Menjalankan yt-dlp + ffmpeg di PC ini dan mengekspos dua hal:
 *   1. POST /            -> kontrak provider REST Ambil (metadata + varian)
 *   2. GET  /media/<id>  -> streaming berkas, di-proxy dari PC ini
 *
 * Varian yang butuh muxing (YouTube DASH) dialirkan sebagai MP4 fragmen,
 * jadi unduhan tetap berjalan walau file lebih besar dari batas Vercel.
 *
 * Tanpa dependency eksternal: cukup Node.js + yt-dlp.exe + ffmpeg.exe.
 *
 * Env:
 *   PORT              port lokal (default 8787)
 *   BRIDGE_SECRET     wajib; dipakai klien sebagai Bearer token
 *   PUBLIC_BASE_URL   URL publik tunnel, mis. https://xxx.trycloudflare.com
 *   YTDLP_PATH        path yt-dlp(.exe)
 *   FFMPEG_PATH       path ffmpeg(.exe); tanpa ini muxing dinonaktifkan
 *   EXTRACT_TIMEOUT_MS default 60000
 *   TOKEN_TTL_MS      masa berlaku tautan media, default 2700000 (45 menit)
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import os from 'node:os'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const SECRET = process.env.BRIDGE_SECRET || ''
const TUNNEL = process.env.TUNNEL === '1'
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || ''
let publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
const YTDLP = process.env.YTDLP_PATH || path.join(process.cwd(), 'bin', 'yt-dlp.exe')
const FFMPEG = process.env.FFMPEG_PATH || ''
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 60_000)
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 45 * 60_000)
const MAX_TOKENS = 2_000

/**
 * Cookies opsional untuk platform yang memblokir IP datacenter
 * (YouTube "confirm you're not a bot", Instagram, Facebook).
 * Isi COOKIES_B64 dengan hasil `base64 cookies.txt`, atau tunjuk
 * COOKIES_PATH ke berkas Netscape cookies yang sudah ada.
 */
const COOKIES_PATH = (() => {
  const inline = process.env.COOKIES_B64 || ''
  if (inline) {
    try {
      const file = path.join(os.tmpdir(), 'ambil-cookies.txt')
      fs.writeFileSync(file, Buffer.from(inline, 'base64'))
      return file
    } catch (error) {
      logStartupIssue(`COOKIES_B64 tidak bisa ditulis: ${error instanceof Error ? error.message : error}`)
    }
  }
  const explicit = process.env.COOKIES_PATH || ''
  return explicit && fs.existsSync(explicit) ? explicit : ''
})()

function logStartupIssue(message) {
  console.error(`[bridge] ${message}`)
}

if (!SECRET || SECRET.length < 24) {
  console.error('[bridge] BRIDGE_SECRET wajib diisi (minimal 24 karakter).')
  process.exit(1)
}

if (!fs.existsSync(YTDLP)) {
  console.error(`[bridge] yt-dlp tidak ditemukan di ${YTDLP}`)
  process.exit(1)
}

const HAS_FFMPEG = Boolean(FFMPEG && fs.existsSync(FFMPEG))
const TOKEN_HASH = createHash('sha256').update(SECRET).digest()
const LOG_FILE = process.env.LOG_FILE || ''
const CF_LOG_FILE = process.env.CF_LOG_FILE || ''

/** @type {Map<string, {video?: object, audio?: object, single?: object, image?: object, filename: string, container: string, expires: number}>} */
const mediaTokens = new Map()

let ytdlpVersion = 'unknown'

function log(...args) {
  const line = `[bridge ${new Date().toISOString().slice(11, 19)}] ${args
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ')}`
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, `${line}\n`)
    } catch {
      // logging tidak boleh menjatuhkan bridge
    }
  }
  console.log(line)
}

function logCloudflared(chunk) {
  if (!CF_LOG_FILE) return
  try {
    fs.appendFileSync(CF_LOG_FILE, chunk)
  } catch {
    // abaikan
  }
}

process.on('uncaughtException', (error) => {
  log('uncaught:', error?.stack || String(error))
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  log('unhandled rejection:', String(reason))
})

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

function isAuthorized(req) {
  const header = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  const given = createHash('sha256').update(match[1].trim()).digest()
  return given.length === TOKEN_HASH.length && timingSafeEqual(given, TOKEN_HASH)
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sanitizeFilename(name, fallback = 'media') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
  return cleaned || fallback
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const rateBuckets = new Map()

function rateLimited(key, limit = 40, windowMs = 60_000) {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  bucket.count += 1
  return bucket.count > limit
}

function baseUrlFor(req) {
  if (publicBase) return publicBase
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`
  // Proxy platform (Back4App, Render) kadang tidak meneruskan x-forwarded-proto.
  // Tanpa ini tautan media jadi http:// dan diblokir browser sebagai mixed content.
  const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host))
  const proto = req.headers['x-forwarded-proto'] || (isLocal ? 'http' : 'https')
  return `${proto}://${host}`.replace(/\/+$/, '')
}

let tunnelChild = null

/**
 * Cloudflare quick tunnel dijalankan sebagai child process supaya URL-nya
 * bisa langsung dipakai untuk membangun tautan media. Tanpa ini, URL tunnel
 * tidak diketahui sampai log dibaca dari luar.
 */
function startTunnel() {
  if (!TUNNEL) return
  if (!CLOUDFLARED || !fs.existsSync(CLOUDFLARED)) {
    log('TUNNEL=1 tetapi cloudflared tidak ditemukan:', CLOUDFLARED || '(kosong)')
    return
  }

  tunnelChild = spawn(
    CLOUDFLARED,
    ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--loglevel', 'info'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let buffer = ''
  const onData = (chunk) => {
    logCloudflared(chunk.toString())
    buffer = (buffer + chunk.toString()).slice(-8000)
    if (!publicBase) {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buffer)
      if (match) {
        publicBase = match[0]
        log('tunnel siap:', publicBase)
      }
    }
  }

  tunnelChild.stdout.on('data', onData)
  tunnelChild.stderr.on('data', onData)
  tunnelChild.on('error', (error) => log('cloudflared error:', error.message))
  tunnelChild.on('exit', (code) => {
    log('cloudflared berhenti dengan kode', code)
    if (code !== 0 && buffer) log('cloudflared terakhir:', buffer.slice(-600))
  })
}

function stopTunnel() {
  if (tunnelChild && !tunnelChild.killed) {
    tunnelChild.kill('SIGKILL')
  }
}

process.on('exit', stopTunnel)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

function runYtdlp(url) {
  return new Promise((resolve, reject) => {
    const isYouTube = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)
    const playerClient = process.env.YTDLP_PLAYER_CLIENT || ''
    const potUrl = process.env.YTDLP_POT_URL || ''
    const args = [
      '--no-warnings',
      '--no-progress',
      '--socket-timeout',
      '20',
      '--retries',
      '2',
      '--extractor-retries',
      '2',
      ...(COOKIES_PATH ? ['--cookies', COOKIES_PATH] : []),
      ...(isYouTube && playerClient
        ? ['--extractor-args', `youtube:player_client=${playerClient}`]
        : []),
      ...(isYouTube && potUrl
        ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${potUrl}`]
        : []),
      '-J',
      url,
    ]

    const child = spawn(YTDLP, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const stdout = []
    let stderr = ''
    let size = 0
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('timeout'))
    }, EXTRACT_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 32 * 1024 * 1024) {
        child.kill()
        return
      }
      stdout.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code !== 0) {
        const message = stderr.trim().split('\n').slice(-25).join(' | ') || `yt-dlp keluar dengan kode ${code}`
        reject(new Error(message))
        return
      }

      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')))
      } catch {
        reject(new Error('output yt-dlp bukan JSON'))
      }
    })
  })
}

function normalizeInfo(info) {
  if (info && info._type === 'playlist' && Array.isArray(info.entries)) {
    const entries = info.entries.filter(Boolean)
    const playable = entries.filter((entry) => Array.isArray(entry.formats) && entry.formats.length > 0)
    if (playable.length === 1) {
      return { ...playable[0], title: info.title || playable[0].title }
    }
    if (playable.length === 0) return { ...info, entries }
    return { ...info, entries: playable }
  }
  return info
}

function formatHeaders(format) {
  const source = format?.http_headers || {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value
  }
  return out
}

function bestBy(list, score) {
  return list.reduce((best, item) => (best === null || score(item) > score(best) ? item : best), null)
}

function formatSize(format) {
  const size = format?.filesize || format?.filesize_approx
  return Number.isFinite(size) && size > 0 ? size : undefined
}

/**
 * Hanya format yang bisa diunduh langsung. YouTube sering menawarkan varian
 * HLS/DASH (protocol `m3u8`, `dash`, `http_dash_segments`) yang URL-nya berupa
 * playlist, bukan berkas — ffmpeg tidak bisa memprosesnya dan pengunduhan gagal.
 */
function isDirectFormat(format) {
  const protocol = String(format?.protocol || 'https').toLowerCase()
  return protocol === 'https' || protocol === 'http'
}

function buildVariants(info, baseUrl) {
  const formats = (info.formats || []).filter((f) => f && f.url && isDirectFormat(f))
  const isVideo = (f) => typeof f.vcodec === 'string' && f.vcodec !== 'none'
  const isAudio = (f) => typeof f.acodec === 'string' && f.acodec !== 'none'

  const videoOnly = formats.filter((f) => isVideo(f) && !isAudio(f))
  const progressive = formats.filter((f) => isVideo(f) && isAudio(f))
  const audioOnly = formats.filter((f) => !isVideo(f) && isAudio(f))

  const preferAac = (list) => list.filter((f) => String(f.acodec || '').startsWith('mp4a'))
  const audioPool = preferAac(audioOnly).length > 0 ? preferAac(audioOnly) : audioOnly
  const audio = bestBy(audioPool, (f) => (f.abr || 0) + (f.tbr || 0) / 100)

  const heights = [
    ...new Set(
      [...videoOnly, ...progressive]
        .map((f) => f.height)
        .filter((height) => Number.isFinite(height) && height > 0 && height <= 1080),
    ),
  ].sort((a, b) => b - a)

  const targets = [1080, 720, 480, 360].filter((height) => heights.includes(height))
  const selectedHeights = targets.length > 0 ? targets : heights.slice(0, 2)

  const title = sanitizeFilename(info.title || info.id || 'media')
  const variants = []

  const addToken = (payload, filename, container) => {
    const id = randomBytes(16).toString('hex')
    if (mediaTokens.size >= MAX_TOKENS) {
      for (const [key, entry] of mediaTokens) {
        if (entry.expires <= Date.now()) mediaTokens.delete(key)
      }
      if (mediaTokens.size >= MAX_TOKENS) {
        const oldest = mediaTokens.keys().next().value
        if (oldest) mediaTokens.delete(oldest)
      }
    }
    mediaTokens.set(id, { ...payload, filename, container, expires: Date.now() + TOKEN_TTL_MS })
    return `${baseUrl}/media/${id}`
  }

  for (const height of selectedHeights) {
    const progressiveAtHeight = progressive.filter((f) => f.height === height)
    const muxed = bestBy(progressiveAtHeight, (f) => (f.tbr || 0) + (f.ext === 'mp4' ? 50 : 0))

    if (muxed) {
      const container = muxed.ext === 'webm' ? 'webm' : 'mp4'
      const filename = `${title} - ${height}p.${container}`
      variants.push({
        kind: 'video',
        quality: `${height}p`,
        container,
        filename,
        url: addToken({ single: { url: muxed.url, headers: formatHeaders(muxed) } }, filename, container),
        size: formatSize(muxed),
        width: muxed.width,
        height: muxed.height,
        direct: true,
      })
      continue
    }

    const videoCandidates = videoOnly.filter((f) => f.height === height)
    const h264 = videoCandidates.filter((f) => String(f.vcodec || '').startsWith('avc1'))
    const video = bestBy(h264.length > 0 ? h264 : videoCandidates, (f) => (f.tbr || 0) + (f.ext === 'mp4' ? 50 : 0))

    if (video && audio && HAS_FFMPEG) {
      const container = String(audio.acodec || '').startsWith('mp4a') ? 'mp4' : 'mkv'
      const filename = `${title} - ${height}p.${container}`
      const videoSize = formatSize(video)
      const audioSize = formatSize(audio)
      variants.push({
        kind: 'video',
        quality: `${height}p`,
        container,
        filename,
        url: addToken(
          {
            video: { url: video.url, headers: formatHeaders(video) },
            audio: { url: audio.url, headers: formatHeaders(audio) },
          },
          filename,
          container,
        ),
        size: videoSize && audioSize ? videoSize + audioSize : undefined,
        width: video.width,
        height: video.height,
        direct: true,
      })
      continue
    }

    if (video) {
      const container = video.ext === 'webm' ? 'webm' : 'mp4'
      const filename = `${title} - ${height}p (tanpa audio).${container}`
      variants.push({
        kind: 'video',
        label: `${height}p tanpa audio`,
        quality: `${height}p`,
        container,
        filename,
        url: addToken({ single: { url: video.url, headers: formatHeaders(video) } }, filename, container),
        size: formatSize(video),
        width: video.width,
        height: video.height,
        direct: true,
      })
    }
  }

  if (audio) {
    const container = audio.ext === 'mp4' || audio.ext === 'm4a' ? 'm4a' : audio.ext === 'webm' ? 'webm' : 'm4a'
    const filename = `${title} - audio.${container}`
    variants.push({
      kind: 'audio',
      label: 'Audio',
      quality: audio.abr ? `${Math.round(audio.abr)} kbps` : undefined,
      container,
      filename,
      url: addToken({ single: { url: audio.url, headers: formatHeaders(audio) } }, filename, container),
      size: formatSize(audio),
      direct: true,
    })
  }

  // Carousel foto (mis. Instagram) dari playlist yt-dlp.
  const entries = Array.isArray(info.entries) ? info.entries : []
  let imageIndex = 0
  for (const entry of entries) {
    if (Array.isArray(entry.formats) && entry.formats.length > 0) continue
    const ext = String(entry.ext || '').toLowerCase()
    const isImage = ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)
    if (!isImage || !entry.url) continue
    imageIndex += 1
    const container = ext === 'jpeg' ? 'jpg' : ext
    const filename = `${title} - gambar-${imageIndex}.${container}`
    variants.push({
      kind: 'image',
      label: `Gambar ${imageIndex}`,
      container,
      filename,
      url: addToken({ single: { url: entry.url, headers: {} } }, filename, container),
      direct: true,
    })
  }

  return { variants, title: info.title || title, author: info.uploader || info.channel || info.creator }
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : []
  const last = thumbs[thumbs.length - 1]
  return last?.url
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

async function handleExtract(req, res, baseUrl) {
  const ip = clientIp(req)
  if (rateLimited(ip)) {
    json(res, 429, { error: 'rate_limited', message: 'Terlalu banyak permintaan.' })
    return
  }

  if (!isAuthorized(req)) {
    json(res, 401, { error: 'unauthorized', message: 'API key tidak valid.' })
    return
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    json(res, 400, { error: 'invalid_body', message: 'Body harus JSON { "url": "..." }.' })
    return
  }

  let target
  try {
    target = new URL(String(body?.url || ''))
    if (!/^https?:$/.test(target.protocol)) throw new Error('protocol')
  } catch {
    json(res, 422, { error: 'invalid_url', message: 'URL tidak valid.' })
    return
  }

  const started = Date.now()
  let info
  try {
    info = normalizeInfo(await runYtdlp(target.toString()))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ekstraksi gagal.'
    log('extract gagal', target.hostname, message)
    json(res, 502, { error: 'extract_failed', message })
    return
  }

  const { variants, title, author } = buildVariants(info, baseUrl)

  if (variants.length === 0) {
    json(res, 422, {
      error: 'no_variants',
      message: 'Tidak ada format yang bisa diunduh. Media mungkin privat atau dibatasi.',
    })
    return
  }

  log('extract', target.hostname, `${Date.now() - started}ms`, `${variants.length} varian`)

  json(res, 200, {
    title: String(title || 'Media').slice(0, 300),
    author: author ? String(author).slice(0, 200) : undefined,
    thumbnail: pickThumbnail(info),
    duration: Number.isFinite(info.duration) && info.duration > 0 ? info.duration : undefined,
    variants,
  })
}

function ffmpegArgs(video, audio, container) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']

  const addInput = (item) => {
    if (item.headers['user-agent']) args.push('-user_agent', item.headers['user-agent'])
    if (item.headers.referer) args.push('-headers', `Referer: ${item.headers.referer}\r\n`)
    args.push('-i', item.url)
  }

  addInput(video)
  addInput(audio)

  args.push('-map', '0:v:0', '-map', '1:a:0', '-c', 'copy')

  if (container === 'mkv') {
    args.push('-f', 'matroska')
  } else {
    args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof')
  }

  args.push('pipe:1')
  return args
}

async function pipeSingleMedia(entry, req, res) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  const headers = { ...entry.single.headers }
  if (req.headers.range) headers.range = req.headers.range

  let upstream
  try {
    upstream = await fetch(entry.single.url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    })
  } catch {
    if (!res.headersSent) json(res, 502, { error: 'upstream_unreachable', message: 'Sumber media tidak dapat dihubungi.' })
    return
  }

  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel()
    if (!res.headersSent) {
      json(res, 502, { error: 'upstream_error', message: `Sumber media menolak (HTTP ${upstream.status}).` })
    }
    return
  }

  const responseHeaders = {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'content-disposition': contentDisposition(entry.filename),
    'cache-control': 'private, no-store, max-age=0',
    'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
    'x-content-type-options': 'nosniff',
  }

  const length = upstream.headers.get('content-length')
  if (length) responseHeaders['content-length'] = length
  const range = upstream.headers.get('content-range')
  if (range) responseHeaders['content-range'] = range

  res.writeHead(upstream.status, responseHeaders)

  if (!upstream.body) {
    res.end()
    return
  }

  Readable.fromWeb(upstream.body)
    .on('error', () => res.destroy())
    .pipe(res)
}

function pipeMuxedMedia(entry, res) {
  const args = ffmpegArgs(entry.video, entry.audio, entry.container)
  const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  let started = false
  let finished = false

  const idleTimer = setTimeout(() => {
    if (started || finished) return
    finished = true
    child.kill('SIGKILL')
    if (!res.headersSent) {
      json(res, 502, { error: 'mux_timeout', message: 'ffmpeg tidak menghasilkan data tepat waktu.' })
    }
  }, 45_000)

  const stop = () => {
    clearTimeout(idleTimer)
    if (!child.killed) child.kill('SIGKILL')
  }

  res.on('close', stop)

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })

  child.on('error', () => {
    clearTimeout(idleTimer)
    if (started || finished) return
    finished = true
    if (!res.headersSent) json(res, 502, { error: 'ffmpeg_failed', message: 'ffmpeg tidak dapat dijalankan.' })
  })

  child.stdout.once('data', (firstChunk) => {
    if (finished) return
    clearTimeout(idleTimer)
    started = true
    res.writeHead(200, {
      'content-type': entry.container === 'mkv' ? 'video/x-matroska' : 'video/mp4',
      'content-disposition': contentDisposition(entry.filename),
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    })
    res.write(firstChunk)
    child.stdout.pipe(res)
  })

  child.on('close', (code) => {
    clearTimeout(idleTimer)
    if (finished) return
    if (!started) {
      finished = true
      if (!res.headersSent) {
        json(res, 502, {
          error: 'mux_failed',
          message: stderr.trim().split('\n').pop() || `ffmpeg keluar dengan kode ${code}`,
        })
      }
      return
    }
    finished = true
    res.end()
  })
}

function handleMedia(req, res, id) {
  const entry = mediaTokens.get(id)
  if (!entry) {
    json(res, 404, { error: 'not_found', message: 'Tautan media tidak ditemukan atau sudah kedaluwarsa.' })
    return
  }
  if (entry.expires <= Date.now()) {
    mediaTokens.delete(id)
    json(res, 410, { error: 'expired', message: 'Tautan media sudah kedaluwarsa. Ambil ulang tautan sumbernya.' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed', message: 'Gunakan GET.' }, { allow: 'GET' })
    return
  }

  if (entry.single) {
    void pipeSingleMedia(entry, req, res)
    return
  }
  if (entry.video && entry.audio && HAS_FFMPEG) {
    pipeMuxedMedia(entry, res)
    return
  }

  json(res, 503, {
    error: 'ffmpeg_missing',
    message: 'ffmpeg tidak tersedia, format ini butuh muxing. Unduh format progresif atau pasang ffmpeg.',
  })
}

const server = http.createServer((req, res) => {
  const started = Date.now()
  const url = new URL(req.url || '/', 'http://localhost')

  res.on('finish', () => {
    log(req.method, url.pathname, res.statusCode, `${Date.now() - started}ms`)
  })

  if (url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      ytdlp: path.basename(YTDLP),
      ytdlpVersion,
      ffmpeg: HAS_FFMPEG,
      tunnel: TUNNEL,
      publicBase: publicBase || null,
      cookies: Boolean(COOKIES_PATH),
      tokens: mediaTokens.size,
      uptimeSeconds: Math.round(process.uptime()),
    })
    return
  }

  if (url.pathname === '/' && req.method === 'POST') {
    handleExtract(req, res, baseUrlFor(req)).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal_error', message: 'Kesalahan internal bridge.' })
    })
    return
  }

  if (url.pathname === '/' && req.method === 'GET') {
    json(res, 200, { name: 'ambil-bridge', version: '1.0.0', uses: ['yt-dlp', 'ffmpeg'] })
    return
  }

  const mediaMatch = /^\/media\/([a-f0-9]{32})$/.exec(url.pathname)
  if (mediaMatch?.[1]) {
    handleMedia(req, res, mediaMatch[1])
    return
  }

  json(res, 404, { error: 'not_found', message: 'Endpoint tidak dikenal.' })
})

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of mediaTokens) {
    if (entry.expires <= now) mediaTokens.delete(key)
  }
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key)
  }
}, 60_000).unref()

server.listen(PORT, HOST, () => {
  spawn(YTDLP, ['--version'], { windowsHide: true })
    .stdout?.on('data', (chunk) => {
      ytdlpVersion = chunk.toString().trim()
      log('yt-dlp', ytdlpVersion)
    })

  log(`siap di http://${HOST}:${PORT}`)
  log(`base publik: ${publicBase || (TUNNEL ? 'menunggu tunnel...' : '(mengikuti header request)')}`)
  log(`ffmpeg: ${HAS_FFMPEG ? FFMPEG : 'tidak tersedia'}`)
  log(`cookies: ${COOKIES_PATH || 'tidak dipakai'}`)

  startTunnel()
})
