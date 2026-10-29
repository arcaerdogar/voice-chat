FROM node:22-alpine
ENV NODE_ENV=production

# Müzik akışı için yt-dlp. Ayrı bir Python ortamına kurulur ve node kullanıcısına verilir;
# böylece sunucu yt-dlp'yi çalışırken kendisi güncelleyebilir (YouTube değiştikçe gerekir).
# YouTube'un JS doğrulaması için yt-dlp imajdaki Node'u kullanır (--js-runtimes node).
RUN apk add --no-cache python3 \
 && python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" \
 && chown -R node:node /opt/ytdlp
ENV YTDLP_BIN=/opt/ytdlp/bin/yt-dlp \
    YTDLP_PIP=/opt/ytdlp/bin/pip

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js sources.js ytdlp.js admin.js uploads.js ./
COPY admin ./admin
COPY public ./public
# Sohbette paylaşılan dosyalar (geçici: 24 saat sonra ya da kanal boşalınca silinir)
RUN mkdir -p /uploads && chown node:node /uploads
ENV UPLOAD_DIR=/uploads
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
