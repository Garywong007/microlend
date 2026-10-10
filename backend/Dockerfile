# Build from the REPOSITORY ROOT:  docker build -f backend/Dockerfile -t microlend-api .
FROM node:22-slim

WORKDIR /app

# toolchain for native modules (better-sqlite3 falls back to compiling if no prebuilt binary matches)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/
RUN cd backend && npm install --omit=dev

COPY backend backend
COPY shared shared
COPY ml/model.json ml/model.json
COPY deployments deployments

RUN mkdir -p backend/data && chown -R node:node /app
USER node

ENV NODE_ENV=production PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/src/server.js"]
