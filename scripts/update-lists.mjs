// Moves the pins in lists.lock.json to the newest published lists.
// This is the only step that changes which list versions get built.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { download, sha256, writeCache } from "./fetch.mjs";
import { LISTS, LOCK_FILE, MIRROR } from "./lists.mjs";

function resolveCommit() {
  const out = execFileSync("git", ["ls-remote", MIRROR.repo, `refs/heads/${MIRROR.branch}`], {
    encoding: "utf8",
  });
  const commit = out.split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Could not resolve ${MIRROR.repo} ${MIRROR.branch}: ${out}`);
  }
  return commit;
}

function header(text, key) {
  const match = new RegExp(`^! ${key}: (.+)$`, "m").exec(text.slice(0, 4096));
  return match ? match[1].trim() : null;
}

const commit = resolveCommit();
const fetchedAt = new Date().toISOString().slice(0, 10);
const lists = [];

for (const list of LISTS) {
  const sourceUrl = `${MIRROR.rawBase}/${commit}/${list.file}`;
  const buffer = await download(sourceUrl);
  const text = buffer.toString("utf8");
  const entry = {
    id: list.id,
    title: header(text, "Title") ?? list.title,
    version: header(text, "Version"),
    lastModified: header(text, "Last modified"),
    canonicalUrl: list.canonicalUrl,
    sourceUrl,
    source: MIRROR.note,
    mirrorCommit: commit,
    fetchedAt,
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
  await writeCache(entry, buffer);
  lists.push(entry);
  console.log(`${entry.id}: version ${entry.version}, ${entry.bytes} bytes, sha256 ${entry.sha256}`);
}

await writeFile(LOCK_FILE, JSON.stringify({ lockfileVersion: 1, lists }, null, 2) + "\n");
console.log(`Wrote ${LOCK_FILE}`);
