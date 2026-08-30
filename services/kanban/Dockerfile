# Kanban Service — build from the REPO ROOT, not this directory, so the hoisting convention
# this service's own package.json documents (deps resolved from the root node_modules, no
# separate install step) still works inside the container exactly like it does locally.
#
#   docker build -f services/kanban/Dockerfile -t cargodesk-kanban-service .
#
# NOT independently verified by running/building in this environment — see the root Dockerfile's
# own note on why.

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY services/kanban ./services/kanban

ENV NODE_ENV=production
# Set DATABASE_URL (a real Postgres connection string) in the running container's environment —
# see ARCHITECTURE.md §13 (Postgres migration, Phase 3). Without it, this service falls back to
# an embedded @electric-sql/pglite instance persisted to services/kanban/pgdata/ inside the
# container — functionally correct but not durable across container recreation unless that path
# is also given its own volume, and not the intended production setup either way.
EXPOSE 3007
CMD ["node", "services/kanban/server.js"]
