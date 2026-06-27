import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const targetTriples = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const key = `${process.platform}-${process.arch}`;
const targetTriple = process.env.TAURI_TARGET_TRIPLE || targetTriples[key];

if (!targetTriple) {
  throw new Error(`No Tauri sidecar target triple configured for ${key}. Set TAURI_TARGET_TRIPLE.`);
}

if (!ffmpegPath) {
  throw new Error("ffmpeg-static did not provide an ffmpeg binary for this platform.");
}

await stat(ffmpegPath);

const ext = process.platform === "win32" ? ".exe" : "";
const outDir = path.resolve("src-tauri", "binaries");
const outPath = path.join(outDir, `ffmpeg-${targetTriple}${ext}`);

await mkdir(outDir, { recursive: true });
await copyFile(ffmpegPath, outPath);

// copyFile doesn't reliably preserve the executable bit; the bundled sidecar
// must stay runnable on macOS/Linux.
if (process.platform !== "win32") {
  await chmod(outPath, 0o755);
}

console.log(`Prepared Tauri ffmpeg sidecar: ${outPath}`);
