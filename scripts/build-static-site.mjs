import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;
const outDir = join(rootDir, "dist", `music-player-static-v${version}`);

const staticFiles = [
  "index.html",
  "app.js",
  "styles.css",
  "favicon.png",
  "app-icon-192.png",
  "app-icon-512.png",
  "manifest.webmanifest",
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const fileName of staticFiles) {
  await copyFile(join(rootDir, fileName), join(outDir, fileName));
}

await copyFile(join(rootDir, "tracks.example.json"), join(outDir, "tracks.json"));
await copyFile(join(rootDir, "docs", "aws-static-deploy.md"), join(outDir, "AWS_STATIC_DEPLOY.md"));
await mkdir(join(outDir, "music"), { recursive: true });
await writeFile(
  join(outDir, "VERSION"),
  `local-music-player v${version}\nBuilt for S3 + CloudFront static hosting.\n`,
);

console.log(`Built ${outDir}`);
