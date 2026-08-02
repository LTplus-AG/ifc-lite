# Reference image for @ifc-lite/collab-server — the real-time collaboration
# sync server. Build context is the repo root (see railway.toml's
# dockerfilePath). Node 22 LTS; pnpm via corepack.
#
# This is intentionally simple (single stage). It installs + builds ONLY the
# collab-server's dependency subgraph (`...`), so it stays off the heavy
# viewer/wasm toolchain. Slim it with a separate runtime stage + `pnpm deploy`
# if image size matters.
FROM node:22-slim AS app
WORKDIR /app

RUN corepack enable

# Copy the whole monorepo (the lockfile + every package.json are needed for a
# frozen, filtered install). A root .dockerignore keeps build artifacts out.
COPY . .

# Install just @ifc-lite/collab-server and its dependency subgraph (keeps the
# image off the heavy viewer/wasm/native toolchain).
RUN pnpm install --frozen-lockfile --filter "@ifc-lite/collab-server..."
# Build the whole upstream chain in topological order (data → mutations →
# pointcloud → ifcx → collab → collab-server). `turbo` is a root-only
# devDependency excluded by the filtered install, so run it via `pnpm dlx`;
# its `build` task (`dependsOn: ["^build"]`) resolves the order.
RUN pnpm dlx turbo@2.9.14 build --filter=@ifc-lite/collab-server

ENV NODE_ENV=production
# Durable Y.Doc persistence — mount a volume here in production.
ENV COLLAB_DATA_DIR=/data
# Set COLLAB_TOKEN_SECRET at runtime to enable signed-link access control.
# The server reads $PORT (host-injected) when COLLAB_PORT is unset.

CMD ["node", "packages/collab-server/dist/bin.js"]
