import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:4318",
        ws: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("x-web-authenticated", "1");
            proxyReq.setHeader("x-web-user", "dev-web");
          });
        }
      },
      "/healthz": {
        target: "http://127.0.0.1:4318",
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("x-web-authenticated", "1");
            proxyReq.setHeader("x-web-user", "dev-web");
          });
        }
      }
    }
  },
  build: {
    outDir: path.resolve(rootDir, "..", "dist-web"),
    emptyOutDir: true
  }
});
