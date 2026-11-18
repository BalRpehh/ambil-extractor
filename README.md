# Ekstraktor Ambil

Image Docker berisi `yt-dlp` + `ffmpeg` untuk mengekstrak media (Instagram,
YouTube, Facebook, TikTok). Dipakai oleh frontend di
<https://mediadownloaderalatkita.vercel.app> melalui kontrak provider REST.

Platform membangun image ini dari `Dockerfile` di root repo.

## Environment

| Nama | Wajib | Isi |
| --- | --- | --- |
| `BRIDGE_SECRET` | ya | Kunci API minimal 24 karakter (`Authorization: Bearer ...`) |
| `PUBLIC_BASE_URL` | tidak | URL publik aplikasi. Kalau kosong, diambil dari header request. |
| `COOKIES_B64` | tidak | Isi `cookies.txt` (format Netscape) dalam base64, untuk lolos pemeriksaan bot. |
| `HOST` / `PORT` | tidak | Default `0.0.0.0` / `3000`. |

## Endpoint

| Method | Path | Fungsi |
| --- | --- | --- |
| `POST` | `/` | Ekstraksi metadata + daftar varian |
| `GET` | `/media/<token>` | Unduhan langsung (token berlaku 45 menit) |
| `GET` | `/health` | Status, versi yt-dlp, ketersediaan ffmpeg |

## Uji cepat

```bash
curl -s https://<host>/health
curl -s -X POST https://<host>/ \
  -H "Authorization: Bearer $BRIDGE_SECRET" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```
