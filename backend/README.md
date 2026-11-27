# JellySwarm backend

Standalone Bun + Express + PostgreSQL service.

```sh
cp .env.example .env
bun install
bun run dev
```

Startup applies sorted SQL migrations transactionally. `GET /health/` reports status, timestamp, and application version.

```sh
bun test
bun run check
bun run build # Docker image is defined in Dockerfile
```
