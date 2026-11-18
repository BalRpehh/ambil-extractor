# Ekstraktor Ambil untuk Render (free instance).
# Render menyuntikkan PORT sendiri; default 10000.
FROM node:22-slim

ENV PORT=10000 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    HOME=/tmp \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl libatomic1 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL --retry 3 -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app

COPY package.json server.js ./

EXPOSE 10000

CMD ["node", "server.js"]
