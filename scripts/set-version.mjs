/**
 * Set the app version across all the files that must agree, from a single
 * source (the git tag in CI: `v0.2.0` -> `0.2.0`).
 *
 *   node scripts/set-version.mjs 0.2.0
 *
 * Updates:
 *   - src-tauri/tauri.conf.json  (drives the installer / bundle version)
 *   - package.json               (npm project version)
 *   - src-tauri/Cargo.toml       ([package] version -> /health "version")
 *
 * Targeted string replacements keep the diffs minimal (no reformatting).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const raw = process.argv[2] ?? process.env.RELEASE_VERSION ?? "";
const version = raw.trim().replace(/^v/i, "");

// Semver core x.y.z, with optional -prerelease (MSI uses the numeric core).
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version: "${raw}". Expected e.g. 0.2.0 or v0.2.0 (optionally -beta.1).`);
  process.exit(1);
}

const root = process.cwd();

const replaceOnce = async (file, pattern, replacement, label) => {
  const full = path.resolve(root, file);
  const text = await readFile(full, "utf8");
  if (!pattern.test(text)) {
    throw new Error(`Could not find the ${label} version field in ${file}`);
  }
  const next = text.replace(pattern, replacement);
  await writeFile(full, next);
  console.log(`Set ${file} -> ${version}`);
};

// JSON top-level "version": "..."  (first match is the top-level field)
await replaceOnce(
  "src-tauri/tauri.conf.json",
  /"version":\s*"[^"]*"/,
  `"version": "${version}"`,
  "tauri.conf.json",
);
await replaceOnce("package.json", /"version":\s*"[^"]*"/, `"version": "${version}"`, "package.json");

// Cargo.toml [package] version = "..."  (a line starting with `version = "` only
// appears in [package]; dependency versions use inline `{ version = "..." }`).
await replaceOnce("src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${version}"`, "Cargo.toml");

console.log(`\nVersion set to ${version}.`);
