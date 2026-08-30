# MDM Service — build from the REPO ROOT, not this directory, so the hoisting convention this
# service's own package.json documents (deps resolved from the root node_modules, no separate
# install step) still works inside the container exactly like it does locally — Node's module
# resolution walks up from services/mdm/ to find node_modules, so the image needs that same
# relative directory structure preserved.
#
#   docker build -f services/mdm/Dockerfile -t cargodesk-mdm-service .
#
# NOT independently verified by running/building in this environment — see the root Dockerfile's
# own note on why.

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY services/mdm ./services/mdm

ENV NODE_ENV=production
# Set DATABASE_URL (a real Postgres connection string) in the running container's environment —
# see ARCHITECTURE.md §13 (Postgres migration, Phase 5, the last of the microservice phases).
# Without it, this service falls back to an embedded @electric-sql/pglite instance persisted to
# services/mdm/pgdata/ inside the container — functionally correct but not durable across
# container recreation unless that path is also given its own volume, and not the intended
# production setup either way.
EXPOSE 3005
CMD ["node", "services/mdm/server.js"]
