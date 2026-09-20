import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const detailsPath = resolve(import.meta.dirname, "../../outputs/jev-extraction-details.json");

function extractionTrace(): Plugin {
  return {
    name: "cargolens-extraction-trace",
    configureServer(server) {
      server.middlewares.use("/extraction-details.json", async (_request, response) => {
        try {
          const body = await readFile(detailsPath, "utf8");
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(body);
        } catch {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "Run npm run submission:extract-all first." }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), extractionTrace()],
  server: { port: 5174, strictPort: true, host: "127.0.0.1" },
  preview: { port: 5174, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
});
