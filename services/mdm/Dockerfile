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
EXPOSE 3005
CMD ["node", "services/mdm/server.js"]
