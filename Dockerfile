# CargoDesk monolith — builds the frontend, then serves it (via server.js's own
# NODE_ENV=production static-file path, added in TKT-L9P6FL) alongside the API.
#
# Build from the REPO ROOT (not this file's own directory in isolation):
#   docker build -f Dockerfile -t cargodesk-monolith .
#
# NOT independently verified by running/building in this environment — no Docker is available
# here (checked directly: no `docker` binary, no native Postgres/Docker install). Written
# against the actual npm scripts, dependencies, and ports this repo uses today; treat as a
# first draft to build-test before relying on it, not as proven-working.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Server code + data CargoDesk needs at runtime (not the frontend source — that's already
# compiled into dist/ below).
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY scripts ./scripts
COPY data ./data
COPY --from=build /app/dist ./dist

EXPOSE 3001
CMD ["node", "server.js"]
