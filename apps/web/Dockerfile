# syntax=docker/dockerfile:1
#
# Serves the static site + dashboard with serve.ts (see apps/web/serve.ts for what it does:
# clean URLs, a 301 off any *.html hit). No build step is required to run it — build.cjs only
# regenerates the checked-in assets/*.js bundles from source/*.tsx, so it's run once here to
# keep the image self-contained if those sources ever change without a manual rebuild first.
#
# Build from the repo root: docker build -f apps/web/Dockerfile -t jellyswarm-web .

FROM oven/bun:1-slim AS base
WORKDIR /repo/apps/web

FROM base AS build
COPY apps/web/package.json .
RUN bun install
COPY apps/web .
RUN bun build.cjs

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/apps/web /repo/apps/web
RUN groupadd --system --gid 1001 jelly && useradd --system --uid 1001 --gid jelly jelly
USER jelly
EXPOSE 4173
CMD ["bun", "run", "serve.ts"]
