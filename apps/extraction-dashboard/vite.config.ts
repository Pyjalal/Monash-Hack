import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const datasets = {
  v2: {
    details: resolve(import.meta.dirname, "../../outputs/jev-extraction-details.json"),
    groundTruth: resolve(import.meta.dirname, "../../training_data/sdoc-hackathon-docker/extracted/data_v2/ground_truth.json"),
  },
  v3: {
    details: resolve(import.meta.dirname, "../../outputs/jev-v3-extraction-details.json"),
    groundTruth: resolve(import.meta.dirname, "../../data_v3/ground_truth.json"),
  },
} as const;

function selectedDataset(requestUrl: string | undefined) {
  const requested = new URL(requestUrl ?? "/", "http://localhost").searchParams.get("dataset");
  return requested === "v2" ? datasets.v2 : datasets.v3;
}

function extractionTrace(): Plugin {
  return {
    name: "cargolens-extraction-trace",
    configureServer(server) {
      server.middlewares.use("/extraction-details.json", async (request, response) => {
        try {
          const body = await readFile(selectedDataset(request.url).details, "utf8");
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
      server.middlewares.use("/ground-truth.json", async (request, response) => {
        try {
          const body = await readFile(selectedDataset(request.url).groundTruth, "utf8");
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(body);
        } catch {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "Ground truth is unavailable." }));
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
