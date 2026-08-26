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
EXPOSE 3007
CMD ["node", "services/kanban/server.js"]
