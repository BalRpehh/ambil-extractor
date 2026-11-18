# Ekstraktor Ambil untuk Render

Image Docker untuk mengekstrak media (Instagram, YouTube, Facebook, TikTok)
memakai `yt-dlp` + `ffmpeg`, sesuai kontrak provider REST aplikasi Ambil.

Render membangun image ini dari `Dockerfile` di root.

## Environment

| Nama | Wajib | Isi |
| --- | --- | --- |
| `BRIDGE_SECRET` | ya | Kunci API minimal 24 karakter (dipakai sebagai `Authorization: Bearer ...`) |
| `PUBLIC_BASE_URL` | tidak | `https://<nama-service>.onrender.com`. Kalau kosong, diambil dari header request. |

## Endpoint

| Method | Path | Fungsi |
| --- | --- | --- |
| `POST` | `/` | Ekstraksi metadata + varian |
| `GET` | `/media/<token>` | Unduhan langsung (token 45 menit) |
| `GET` | `/health` | Status |

`PORT` mengikuti variabel lingkungan dari Render (default `10000`).
