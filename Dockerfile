FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:web

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    OPENFIT_DATA_DIR=/data

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/electron/google-health-service.cjs ./electron/google-health-service.cjs
COPY --from=build /app/electron/fitbit-legacy-service.cjs ./electron/fitbit-legacy-service.cjs
COPY --from=build /app/electron/health-cache.cjs ./electron/health-cache.cjs
COPY --from=build /app/electron/assistant-directives.cjs ./electron/assistant-directives.cjs

RUN useradd --create-home --uid 10001 openfit \
    && mkdir -p /data \
    && chown -R openfit:openfit /app /data

USER openfit

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
