FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js sources.js ./
COPY public ./public
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
