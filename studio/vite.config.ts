import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/studio/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "..", "dist", "studio"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:3000",
      "/ready": "http://127.0.0.1:3000",
      "/v1": "http://127.0.0.1:3000",
    },
  },
});
