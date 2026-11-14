# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

# Next.js serializes rewrites at build time. This is a private service address,
# not a public URL or a credential. Rebuild if the API service address changes.
ARG API_INTERNAL_URL=http://api:4000/api/v1
ENV NEXT_TELEMETRY_DISABLED=1

# Mount source read-only instead of copying the entire monorepo into layers.
# proxy_ca is optional outside managed environments and never enters the image.
RUN --mount=type=bind,target=/src,readonly \
    --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    mkdir -p /app/apps/web /app/apps/api /app/packages/database /app/packages/money; \
    cp /src/package.json /src/package-lock.json /app/; \
    cp /src/apps/api/package.json /app/apps/api/; \
    cp /src/packages/database/package.json /app/packages/database/; \
    cp /src/packages/money/package.json /app/packages/money/; \
    cp /src/apps/web/package.json /src/apps/web/next.config.ts /src/apps/web/tsconfig.json /src/apps/web/postcss.config.mjs /app/apps/web/; \
    cp -R /src/apps/web/src /app/apps/web/src; \
    mkdir -p /app/apps/web/public; \
    if [ -d /src/apps/web/public ]; then cp -R /src/apps/web/public/. /app/apps/web/public/; fi; \
    cd /app; \
    npm ci --strict-ssl=true --include=dev --workspace=@livestar/web --include-workspace-root=false; \
    API_INTERNAL_URL="$API_INTERNAL_URL" npm run build --workspace=@livestar/web; \
    npm prune --omit=dev --workspace=@livestar/web --include-workspace-root=false; \
    npm cache clean --force

FROM node:22-alpine AS runtime
ARG API_INTERNAL_URL=http://api:4000/api/v1
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    API_INTERNAL_URL=${API_INTERNAL_URL} \
    PORT=3000

# Only compiled web output and production web dependencies are retained. Neither
# API code, database credentials, SMTP credentials nor .env files are copied.
RUN --mount=from=builder,source=/app,target=/build,readonly \
    set -eu; \
    mkdir -p /app/apps/web; \
    cp -a /build/node_modules /app/node_modules; \
    cp -a /build/apps/web/.next /app/apps/web/.next; \
    cp -a /build/apps/web/public /app/apps/web/public; \
    cp /build/apps/web/package.json /build/apps/web/next.config.ts /build/apps/web/tsconfig.json /app/apps/web/; \
    cp /build/package.json /build/package-lock.json /app/; \
    chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "/app/apps/web", "--hostname", "0.0.0.0", "--port", "3000"]
