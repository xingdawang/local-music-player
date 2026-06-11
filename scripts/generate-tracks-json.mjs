import { readdir, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".ogg", ".aac"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/generate-tracks-json.mjs <music-dir> [--prefix ./music/] [--output dist/music-player-static-v0.1.0/tracks.json]",
      "",
      "The script matches .lrc and artwork files by the same basename as each audio file.",
    ].join("\n"),
  );
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function stripExtension(fileName) {
  return fileName.slice(0, fileName.length - extname(fileName).length);
}

function parseTrackName(fileName) {
  const stem = stripExtension(fileName);
  const parts = stem.split(" - ");
  if (parts.length < 2) {
    return { artist: "Unknown Artist", title: stem };
  }

  return {
    artist: parts[0],
    title: parts.slice(1).join(" - "),
  };
}

function urlFor(prefix, fileName) {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${normalizedPrefix}${encodeURIComponent(fileName)}`;
}

const musicDir = process.argv[2];
if (!musicDir || musicDir.startsWith("--")) {
  usage();
  process.exit(1);
}

const prefix = readOption("--prefix", "./music/");
const output = readOption("--output", "");
const entries = await readdir(musicDir, { withFileTypes: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
const lrcByStem = new Map();
const imageByStem = new Map();

for (const fileName of files) {
  const extension = extname(fileName).toLowerCase();
  const stem = stripExtension(fileName);
  if (extension === ".lrc") {
    lrcByStem.set(stem, fileName);
  } else if (IMAGE_EXTENSIONS.has(extension)) {
    imageByStem.set(stem, fileName);
  }
}

const tracks = files
  .filter((fileName) => AUDIO_EXTENSIONS.has(extname(fileName).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  .map((fileName) => {
    const extension = extname(fileName).toLowerCase();
    const stem = stripExtension(fileName);
    const parsed = parseTrackName(fileName);
    const lyricFile = lrcByStem.get(stem);
    const imageFile = imageByStem.get(stem);

    return {
      artist: parsed.artist,
      title: parsed.title,
      name: fileName,
      extension: extension.slice(1),
      playable: true,
      audioUrl: urlFor(prefix, fileName),
      lyricUrl: lyricFile ? urlFor(prefix, lyricFile) : null,
      imageUrl: imageFile ? urlFor(prefix, imageFile) : null,
      searchText: [parsed.artist, parsed.title, fileName].join(" "),
    };
  });

const payload = `${JSON.stringify({ tracks }, null, 2)}\n`;

if (output) {
  await writeFile(isAbsolute(output) ? output : join(process.cwd(), output), payload);
} else {
  process.stdout.write(payload);
}
