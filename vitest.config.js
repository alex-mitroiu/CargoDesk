import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.js on purpose — that file's proxy/dev-server config has nothing
// to do with running component tests, and mixing them risks a test-only quirk leaking into
// the real dev server config (or vice versa). Matches this repo's existing convention of
// keeping the frontend test run (npm run test:frontend) separate from the backend `npm test`
// chain, since it has different prerequisites (jsdom, no running server needed at all).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    include: ["src/**/*.test.{js,jsx}"],
    css: false,
  },
});
