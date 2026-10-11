import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "http";

// Every /api request is piped straight to the monolith instead of going through Vite's own proxy
// (2026-10-10). Vite 5.4's proxy hung on large responses: the app's startup GET /api/shipments
// (~1.2 MB) stalled about three times in four, leaving the app on "Connecting to database…",
// while the same request direct to :3001 or through a plain pipe never did. When the upstream
// connection broke after the headers were out, Vite never ended the response, so the browser
// waited forever. This pipe also covers the large-body upload it was first added for
// (/api/sanctions/import-csv). The Host header is passed through unchanged, so links the server
// builds from it (password reset, invites, share links) point at the dev frontend, not :3001.
// /ws (WebSocket) stays on Vite's proxy.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "api-passthrough",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!/^\/api(\/|\?|$)/.test(req.url)) return next();
          const proxyReq = http.request(
            { hostname: "localhost", port: 3001, path: req.url, method: req.method, headers: req.headers },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              proxyRes.pipe(res);
              // A break mid-body must reach the browser as a failed request, not a hang.
              proxyRes.on("error", () => res.destroy());
              proxyRes.on("aborted", () => res.destroy());
            }
          );
          proxyReq.on("error", (e) => {
            if (res.headersSent) return res.destroy();
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end(`API proxy error: ${e.message}`);
          });
          // The browser gave up (navigation, abort): stop the upstream request too.
          res.on("close", () => { if (!res.writableFinished) proxyReq.destroy(); });
          req.pipe(proxyReq);
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
