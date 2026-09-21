import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const datasets = new Set(["v2", "v3", "v4", "v5"]);

function selectedDataset(requestUrl: string | undefined) {
  const requested = new URL(requestUrl ?? "/", "http://localhost").searchParams.get("dataset");
  return datasets.has(requested ?? "") ? requested! : "v2";
}

function pipelineReport(): Plugin {
  return {
    name: "cargolens-pipeline-report",
    configureServer(server) {
      server.middlewares.use("/pipeline-report.json", async (request, response) => {
        try {
          const dataset = selectedDataset(request.url);
          const body = await readFile(resolve(import.meta.dirname, `../../outputs/pipeline/${dataset}/report.json`), "utf8");
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(body);
        } catch {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: `Run npm run pipeline:full -- --dataset ${selectedDataset(request.url)} first.` }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pipelineReport()],
  server: { port: 5174, strictPort: true, host: "127.0.0.1" },
  preview: { port: 5174, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
});
