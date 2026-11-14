# Development infrastructure

From the repository root, copy `.env.example` to `.env`. The credentials in that
example are local development values and must never be deployed to an Internet
host. Database URL passwords must be URL-encoded; the Compose defaults use only
URL-safe development passwords.

```sh
docker compose up -d postgres redis
docker compose --profile app up --build -d
docker compose --profile app --profile gateway up -d
curl http://localhost:8080/api/v1/health/ready
```

The app profile builds a Node 22 image, applies migrations with the owner
connection, then starts the API with only the restricted application connection.
The owner credential is not passed into the API. The catalog seed is an explicit
operator command, not an automatic side effect of starting the API. All published
ports bind loopback. Nginx is a local HTTP API gateway; it serves no web UI.

The Postgres initialization script creates `livestar_app` only when a new volume
is initialized. Password changes in `.env` do not alter existing database role
passwords. Apply explicit role-password rotation for an existing volume. Do not
delete database volumes as a password-recovery procedure.

Optional infrastructure:

```sh
docker compose --profile storage up -d
docker compose --profile media up -d
```

MinIO is on ports 9000/9001 by default. LiveKit listens locally on 7880, 7881,
and UDP 50000–50100 with public development keys. Phase 1 does not issue media
tokens, create buckets, upload files, or connect clients to these services.
Remote phone testing needs a later HTTPS/WSS and ICE/TURN configuration.

Builds in a managed environment may require its provided proxy CA. Mount it as
an ephemeral BuildKit secret; do not copy trust files into the image:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" \
  -f infra/docker/api.Dockerfile -t livestar-api:local .
docker compose --profile app up -d --no-build
```

The image retains development dependencies so Prisma migrations can run from
the same artifact. A later production release should split migration and
runtime images, pin image digests, scan dependencies, configure resource limits,
and run load tests. This Compose file is not the production deployment.

# Production prerequisites for later phases

Provision private PostgreSQL and Redis networks; separate restricted runtime and
migration identities; secret injection; TLS termination and renewal; domain DNS;
regional LiveKit/TURN networking; restricted object storage and CDN; monitoring
and alert routing; and encrypted off-host backups with tested restoration.
See [backup tools](backup/README.md). No production credentials, deployment
target, domain, provider approvals, or continuous deployment are configured in
Phase 1. CI verifies code and database invariants but does not publish a service.
