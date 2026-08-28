# Zero-dependency relay — no npm install step needed.
FROM node:22-alpine

WORKDIR /app
COPY package.json handler.mjs server.mjs ./

ENV PORT=8080
EXPOSE 8080
USER node

# Container-level healthcheck (Fly/Render also probe /health over HTTP).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.mjs"]
