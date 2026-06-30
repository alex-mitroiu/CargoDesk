import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "http";

// Routes whose bodies are too large for Vite's proxy buffer — piped directly.
const LARGE_BODY_ROUTES = ["/api/sanctions/import-csv"];

export default defineConfig({
  plugins: [
    react(),
    {
      name: "large-body-passthrough",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!LARGE_BODY_ROUTES.includes(req.url)) return next();
          const proxyReq = http.request(
            { hostname: "localhost", port: 3001, path: req.url, method: req.method, headers: req.headers },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              proxyRes.pipe(res);
            }
          );
          proxyReq.on("error", (e) => { res.writeHead(502); res.end(e.message); });
          req.pipe(proxyReq);
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/ws":  { target: "ws://localhost:3001",   ws: true },
    },
  },
});
