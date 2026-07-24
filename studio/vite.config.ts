import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig(({ command }) => ({
  root: resolve(import.meta.dirname),
  base: "/studio/",
  plugins: [
    react(),
    command === "build"
      ? {
          name: "strip-development-fixtures",
          closeBundle() {
            rmSync(
              resolve(import.meta.dirname, "..", "dist", "studio", "fixtures"),
              {
                force: true,
                recursive: true,
              },
            );
          },
        }
      : undefined,
  ],
  define: {
    __STUDIO_DEV_FIXTURES__: JSON.stringify(command === "serve"),
  },
  resolve: {
    alias: {
      "@studio-fixtures": resolve(
        import.meta.dirname,
        "src",
        command === "serve" ? "fixtures.ts" : "fixtures.disabled.ts",
      ),
    },
  },
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
}));
