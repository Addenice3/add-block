import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CACHE_DIR } from "./lists.mjs";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function cachePath(entry) {
  return path.join(CACHE_DIR, `${entry.id}-${entry.sha256}.txt`);
}

export async function writeCache(entry, buffer) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(entry), buffer);
}

// Returns the pinned list's bytes, downloading it only when it is not cached.
// Throws if the content does not match the pinned hash.
export async function loadPinned(entry) {
  let buffer;
  let cached = true;
  try {
    buffer = await readFile(cachePath(entry));
  } catch {
    console.log(`Downloading ${entry.id} from ${entry.sourceUrl}`);
    buffer = await download(entry.sourceUrl);
    cached = false;
  }
  const actual = sha256(buffer);
  if (actual !== entry.sha256) {
    throw new Error(
      `${entry.id}: sha256 mismatch (lock ${entry.sha256}, got ${actual}) for ${entry.sourceUrl}`,
    );
  }
  if (!cached) await writeCache(entry, buffer);
  return buffer;
}
