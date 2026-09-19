import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "../..");
const esbuildRoot = resolve(repoRoot, "../Monash-Hack/node_modules/esbuild");
const require = createRequire(import.meta.url);
const esbuild = require(resolve(esbuildRoot, "lib/main.js"));
const dist = resolve(extensionRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await esbuild.build({
  absWorkingDir: extensionRoot,
  entryPoints: { background: "src/background.ts", content: "src/content.ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outdir: dist,
  sourcemap: false,
  legalComments: "none",
});
await copyFile(resolve(extensionRoot, "manifest.json"), resolve(dist, "manifest.json"));
console.log(`CargoLens extension built at ${dist}`);
