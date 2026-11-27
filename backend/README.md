# JellySwarm backend

Standalone Bun + Express + PostgreSQL service.

```sh
cp .env.example .env
bun install
bun run dev
```

Startup applies sorted SQL migrations transactionally. `GET /health/` is public and reports status, timestamp, application version, and `buildSha` (set with the Docker build argument `APP_COMMIT_SHA`). Every other request requires `x-api-key: $MASTER_API_KEY` and fails closed if the key is not configured. Keep this key on trusted servers; a browser frontend must not embed it.

```sh
bun test
bun run check
bun run build # Docker image is defined in Dockerfile
```
