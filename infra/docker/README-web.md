# Production web image

The image serves the existing Next.js application on `0.0.0.0:3000` as the
unprivileged `node` user. A separate NestJS API and media server are required;
the web image does not contain database, SMTP or LiveKit secrets.

From the repository root:

```sh
docker build -f infra/docker/web.Dockerfile \
  --build-arg API_INTERNAL_URL=http://api:4000/api/v1 \
  -t livestar-web:production .
```

`api` must resolve to the private API service on the container network. The
build argument is the full API base URL, including `/api/v1`. Browser requests
remain relative to the public site's `/api/v1` path.

Next.js serializes this rewrite while building. Changing a runtime environment
variable alone does **not** change an existing image's rewrite: rebuild with the
new `API_INTERNAL_URL` when the API service name, port or base path changes.
This address is not a secret; never pass passwords or provider keys as build
arguments.

Managed environments may need the provided proxy certificate during the build:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" \
  -f infra/docker/web.Dockerfile \
  --build-arg API_INTERNAL_URL=http://api:4000/api/v1 \
  -t livestar-web:production .
```

The CA is mounted only during the dependency/build step; TLS verification stays
enabled and the certificate is not copied to the runtime image. Dependencies
are installed from `package-lock.json` for the web workspace only, with its
development dependencies used during compilation and pruned afterward.

Use the image behind the production HTTPS proxy. The application listens on
port 3000; do not expose database services through the public proxy. The image's
health check requests `http://127.0.0.1:3000/` and tests web HTTP liveness only.
API/database readiness is checked separately at `/api/v1/health/ready`.

The image uses ordinary `next start` and the repository's current non-standalone
Next configuration. No new public deployment or successful image build is
asserted by this file; deployment verification must be recorded after the
target host, DNS and TLS setup are available.
