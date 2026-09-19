import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const dist = resolve(extensionRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: extensionRoot,
  entryPoints: { background: "src/background.ts", content: "src/content.ts", popup: "src/popup.ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outdir: dist,
  sourcemap: false,
  legalComments: "none",
});
await copyFile(resolve(extensionRoot, "manifest.json"), resolve(dist, "manifest.json"));
await copyFile(resolve(extensionRoot, "popup.html"), resolve(dist, "popup.html"));
