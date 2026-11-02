# ---- Stage 1: build web client -------------------------------------------
FROM node:24-slim AS web-build
WORKDIR /build
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @hermodmail/web --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace @hermodmail/web

# ---- Stage 2: build server (TypeScript) ------------------------------------
FROM node:24-slim AS server-build
WORKDIR /build
COPY apps/server/package.json apps/server/package.json
RUN npm install --workspace @hermodmail/server --no-audit --no-fund
COPY apps/server apps/server
RUN npm run build --workspace @hermodmail/server

# ---- Stage 3: runtime -------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# better-sqlite3 ships prebuilt binaries for linux x64/arm64 on node 24; fall back needs build tools only in rare cases.
COPY --from=server-build /build/node_modules ./node_modules
COPY --from=server-build /build/apps/server/dist ./dist
COPY --from=server-build /build/apps/server/package.json ./package.json
COPY --from=web-build /build/apps/web/dist ./public
RUN useradd --system --uid 10001 hermod && mkdir -p /data && chown hermod:hermod /data
USER hermod
ENV HERMODMAIL_DATA_DIR=/data \
    HERMODMAIL_WEB_DIST=/app/public \
    PORT=8667 \
    HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8667
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8667/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
