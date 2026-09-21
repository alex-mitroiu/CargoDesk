# Screening Service — build from the REPO ROOT, not this directory, so the hoisting convention
# this service's own package.json documents (deps resolved from the root node_modules, no
# separate install step) still works inside the container exactly like it does locally.
#
#   docker build -f services/screening/Dockerfile -t cargodesk-screening-service .
#
# NOT independently verified by running/building in this environment — see the root Dockerfile's
# own note on why.

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Optional extra CA for networks that re-sign TLS (antivirus HTTPS scanning, a corporate proxy) — without it
# `npm ci` fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Off by default; explained in the root Dockerfile:
#   docker build --secret id=extra_ca,src=docker-secrets/extra_ca.crt -f services/screening/Dockerfile -t cargodesk-screening .
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev
COPY services/screening ./services/screening

ENV NODE_ENV=production
# Set DATABASE_URL (a real Postgres connection string) in the running container's environment —
# see ARCHITECTURE.md §13 (Postgres migration, Phase 1). Without it, this service falls back to
# an embedded @electric-sql/pglite instance persisted to services/screening/pgdata/ inside the
# container — functionally correct but not durable across container recreation unless that path
# is also given its own volume, and not the intended production setup either way.
EXPOSE 3006
CMD ["node", "services/screening/server.js"]
