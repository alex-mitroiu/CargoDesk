# PDF Render Service — build from the REPO ROOT (see document-distribution's own Dockerfile
# for why: this service's package.json hoists puppeteer-core from the root node_modules the
# same way, no separate install step).
#
# Needs a REAL installed browser — puppeteer-core drives one, it doesn't bundle one (see
# lib/pdf-signing.js's original comment on this, now in this service's own server.js).
# resolveBrowserExecutable()'s Linux candidate list already includes /usr/bin/chromium and
# /usr/bin/chromium-browser, matching where Debian's `chromium` package installs — no
# PDF_BROWSER_PATH override needed if that install path holds.
#
#   docker build -f services/pdf-render/Dockerfile -t cargodesk-pdf-render-service .
#
# NOT independently verified by running/building in this environment — no Docker available
# here to actually build and confirm the Chromium install resolves at the expected path.

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY services/pdf-render ./services/pdf-render

ENV NODE_ENV=production
EXPOSE 3003
CMD ["node", "services/pdf-render/server.js"]
