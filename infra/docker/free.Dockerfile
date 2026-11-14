# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
ARG API_INTERNAL_URL=http://127.0.0.1:4001/api/v1
ENV NEXT_TELEMETRY_DISABLED=1

# The source mount is read-only. Explicit source copies exclude nested .env files
# even when an operator's ignore file is incomplete. The optional CA is ephemeral.
RUN --mount=type=bind,target=/src,readonly \
    --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/livestar-build-ca.pem; \
      export SSL_CERT_FILE=/tmp/livestar-build-ca.pem; \
    fi; \
    apk add --no-cache openssl; \
    mkdir -p /app/apps/api /app/apps/web /app/packages/database /app/packages/money /app/scripts; \
    cp /src/package.json /src/package-lock.json /src/tsconfig.base.json /app/; \
    cp /src/apps/api/package.json /src/apps/api/tsconfig.json /src/apps/api/tsconfig.build.json /app/apps/api/; \
    cp -R /src/apps/api/src /app/apps/api/src; \
    cp /src/apps/web/package.json /src/apps/web/next.config.ts /src/apps/web/tsconfig.json /src/apps/web/postcss.config.mjs /app/apps/web/; \
    cp -R /src/apps/web/src /app/apps/web/src; \
    mkdir -p /app/apps/web/public; \
    if [ -d /src/apps/web/public ]; then cp -R /src/apps/web/public/. /app/apps/web/public/; fi; \
    cp /src/packages/database/package.json /src/packages/database/tsconfig.json /app/packages/database/; \
    cp -R /src/packages/database/src /src/packages/database/prisma /app/packages/database/; \
    cp /src/packages/money/package.json /src/packages/money/tsconfig.json /app/packages/money/; \
    cp -R /src/packages/money/src /app/packages/money/; \
    cp /src/scripts/start-free.mjs /app/scripts/; \
    cd /app; \
    npm ci --strict-ssl=true --include=dev --workspace=@livestar/api --workspace=@livestar/web --workspace=@livestar/database --workspace=@livestar/money --include-workspace-root; \
    DATABASE_URL=postgresql://build:build@localhost:5432/build DATABASE_MIGRATION_URL=postgresql://build:build@localhost:5432/build npm run db:generate; \
    API_INTERNAL_URL="$API_INTERNAL_URL" npm run build; \
    npm prune --omit=dev --workspace=@livestar/api --workspace=@livestar/web --workspace=@livestar/database --workspace=@livestar/money --include-workspace-root; \
    npm cache clean --force; \
    rm -f /tmp/livestar-build-ca.pem

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=10000 \
    REDIS_OPTIONAL=true \
    EMAIL_ENABLED=false \
    API_DOCS_ENABLED=false

RUN --mount=from=builder,source=/app,target=/build,readonly \
    --mount=from=builder,source=/usr/lib,target=/build-lib,readonly \
    --mount=from=builder,source=/usr/bin,target=/build-bin,readonly \
    set -eu; \
    mkdir -p /app/apps/api /app/apps/web /app/packages/database /app/packages/money /app/scripts; \
    cp -a /build/node_modules /app/node_modules; \
    cp /build/package.json /build/package-lock.json /build/tsconfig.base.json /app/; \
    cp /build/apps/api/package.json /app/apps/api/; \
    cp -a /build/apps/api/dist /app/apps/api/dist; \
    cp /build/apps/web/package.json /build/apps/web/next.config.ts /build/apps/web/tsconfig.json /app/apps/web/; \
    cp -a /build/apps/web/.next /build/apps/web/public /app/apps/web/; \
    cp /build/packages/database/package.json /app/packages/database/; \
    cp -a /build/packages/database/dist /build/packages/database/prisma /app/packages/database/; \
    cp /build/packages/money/package.json /app/packages/money/; \
    cp -a /build/packages/money/dist /app/packages/money/; \
    cp /build/scripts/start-free.mjs /app/scripts/; \
    cp -a /build-lib/libssl.so.3 /build-lib/libcrypto.so.3 /usr/lib/; \
    cp -a /build-bin/openssl /usr/bin/; \
    chown -R node:node /app

USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/scripts/start-free.mjs"]
