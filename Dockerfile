# CargoDesk monolith — builds the frontend, then serves it (via server.js's own
# NODE_ENV=production static-file path, added in TKT-L9P6FL) alongside the API.
#
# Build from the REPO ROOT (not this file's own directory in isolation):
#   docker build -f Dockerfile -t cargodesk-monolith .
#
# Built and smoke-tested for real on 2026-09-21 (Docker Desktop 4.91 / WSL2, v0.91.6): the image builds,
# boots on the embedded pglite database in ~6s, serves the frontend and API, and — after seeding — carries
# the full reference data. Not covered: running behind a real Postgres (DATABASE_URL), or any orchestrator.
#
# WARNING — the first admin account is the PUBLISHED default admin@cargodesk.com / admin123 unless you set
# ADMIN_EMAIL and ADMIN_PASSWORD (docker run -e ..., or .env under docker compose). Set them for anything
# reachable by someone else. (The test-fixture admin claudeagent@localhost is never created when
# NODE_ENV=production, which this image sets.)
#
# Stop it with `docker stop` (SIGTERM, lets the embedded database close cleanly), not `docker kill`.

# Networks that re-sign TLS (a corporate proxy, or antivirus HTTPS scanning such as Avast's "Web/Mail
# Shield") present a root certificate the container doesn't trust, so `npm ci` fails with
# UNABLE_TO_VERIFY_LEAF_SIGNATURE (surfacing as npm's "Exit handler never called!"). If you're on one,
# pass that root CA as a BuildKit secret — it is mounted only for the npm step, never written into an
# image layer, and without it the build behaves exactly as before:
#   docker build --secret id=extra_ca,src=docker-secrets/extra_ca.crt -f Dockerfile -t cargodesk-monolith .
# (docker-secrets/ is gitignored and dockerignored. Export the certificate from the Windows store or your
# proxy's admin page — it is a public certificate, not a private key. npm ci still verifies every
# package against the integrity hashes in package-lock.json.)

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev
# Server code + data CargoDesk needs at runtime (not the frontend source — that's already
# compiled into dist/ below).
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY scripts ./scripts
COPY data ./data
# Reference dataset scripts/import-mdm-data.js reads the 208 countries and their trade-lane assignments from.
# Without it that script does NOT fail — it prints "Countries: 0 inserted" and carries on — so a seeded
# container ends up with ports but no trade lanes, and every derived lane (shipment trade lane, Space
# Configurations' Origin/Destination Trade) comes back empty. Just this one file, not the whole db/ folder.
COPY db/cargodesk.sample.db ./db/cargodesk.sample.db
COPY --from=build /app/dist ./dist

EXPOSE 3001
CMD ["node", "server.js"]
