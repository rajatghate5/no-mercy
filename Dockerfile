# One image, one process: the Bun server hosts both the WebSocket game and the
# built web client, so a deployment is a single URL.

FROM oven/bun:1.4.4-alpine AS base
WORKDIR /app

# --- deps -------------------------------------------------------------------
# Copied separately so a source-only change does not re-resolve dependencies.
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/engine/package.json   packages/engine/
COPY packages/bots/package.json     packages/bots/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json   packages/server/
COPY packages/web/package.json      packages/web/
RUN bun install --frozen-lockfile

# --- build the client -------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY config ./config
COPY packages ./packages
# Declare that the server will also serve this page, so the client talks to
# its own origin. Without it an HTTPS deploy is indistinguishable from a
# static host and the client disables multiplayer.
ENV VITE_UNO_SAME_ORIGIN=1
RUN cd packages/web && bunx vite build

# --- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# Taken wholesale from the build stage, node_modules included.
#
# The runtime used to assemble itself: node_modules from `deps`, then each
# package copied in separately from the context. That produced an image whose
# node_modules/@mercy/* entries did not resolve to the real sources, and the
# server died on startup with "Cannot find module '@mercy/protocol'" - a
# workspace symlink laid down in a stage where the packages were nothing but
# their package.json files.
#
# Copying one coherent tree costs some image size and cannot drift.
COPY --from=build /app ./

# Bun runs TypeScript directly, so the server has no build step to go stale.
ENV PORT=4040
ENV UNO_STATIC=/app/packages/web/dist
EXPOSE 4040

USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4040)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "packages/server/src/main.ts"]
