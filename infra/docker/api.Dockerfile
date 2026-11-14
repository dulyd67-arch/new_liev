# syntax=docker/dockerfile:1
FROM node:22-alpine AS application

# BuildKit's optional secret extends Node's CA trust in a managed environment.
# It is never copied into an image layer. Ordinary local builds need no secret.
RUN --mount=type=bind,target=/src,readonly \
    --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/livestar-build-ca.pem; \
      export SSL_CERT_FILE=/tmp/livestar-build-ca.pem; \
    fi; \
    mkdir -p /app \
    && cp -R /src/. /app/ \
    && cd /app \
    && apk add --no-cache openssl \
    && npm ci --strict-ssl=true --workspace=@livestar/api --workspace=@livestar/database --workspace=@livestar/money --include-workspace-root \
    && DATABASE_URL=postgresql://build:build@localhost:5432/build \
       DATABASE_MIGRATION_URL=postgresql://build:build@localhost:5432/build \
       npm run db:generate \
    && npm run build --workspace=@livestar/database \
    && npm run build --workspace=@livestar/api \
    && npm prune --omit=dev --workspace=@livestar/api --workspace=@livestar/database --workspace=@livestar/money --include-workspace-root \
    && npm cache clean --force \
    && rm -f /tmp/livestar-build-ca.pem \
    && chown -R node:node /app

ENV NODE_ENV=production PORT=4000
USER node
EXPOSE 4000
CMD ["node", "/app/apps/api/dist/main.js"]
