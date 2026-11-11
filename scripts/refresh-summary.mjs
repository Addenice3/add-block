// Compares the filter lists and build in the working tree with a git ref
// (default HEAD, i.e. what is committed) for the weekly refresh workflow
// (.github/workflows/refresh-lists.yml). Reads only lists.lock.json and
// build-report.json; changes nothing.
//
//   node scripts/refresh-summary.mjs --changed [ref]   prints "true" if any
//                                                      pinned list's content
//                                                      (SHA-256) differs
//   node scripts/refresh-summary.mjs [ref]             prints the refresh pull
//                                                      request body (Markdown)
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { CHROME_LIMITS } from "./limits.mjs";
import { LOCK_FILE } from "./lists.mjs";
import { SAFARI_LIMITS } from "./safari.mjs";

const REPORT_FILE = "build-report.json";

const args = process.argv.slice(2);
const CHANGED = args.includes("--changed");
const REF = args.find((arg) => !arg.startsWith("--")) ?? "HEAD";

const atRef = (file) => JSON.parse(execFileSync("git", ["show", `${REF}:${file}`], { encoding: "utf8" }));
const current = async (file) => JSON.parse(await readFile(file, "utf8"));

const oldLock = atRef(LOCK_FILE);
const newLock = await current(LOCK_FILE);

if (CHANGED) {
  const hashes = (lock) => JSON.stringify(lock.lists.map(({ id, sha256 }) => [id, sha256]));
  console.log(hashes(oldLock) === hashes(newLock) ? "false" : "true");
  process.exit(0);
}

const oldReport = atRef(REPORT_FILE);
const newReport = await current(REPORT_FILE);

const fmt = (n) => (n === undefined ? "–" : n.toLocaleString("en"));
const pct = (used, limit) => `${((used / limit) * 100).toFixed(1)}%`;
function delta(before, after) {
  if (before === undefined) return `${fmt(after)} (new)`;
  if (after === undefined) return `${fmt(before)} → removed`;
  if (before === after) return fmt(after);
  const d = after - before;
  return `${fmt(before)} → ${fmt(after)} (${d > 0 ? "+" : "−"}${fmt(Math.abs(d))})`;
}
const byId = (items) => new Map(items.map((item) => [item.id, item]));
const ids = (a, b) => [...new Set([...a.keys(), ...b.keys()])];
const sum = (items, key) => items.reduce((n, item) => n + (item[key] ?? 0), 0);
const short = (commit) => (commit ? commit.slice(0, 7) : "–");

const out = [];
const line = (text = "") => out.push(text);
// text: how many leading columns hold text (left-aligned); the rest are numbers.
function table(head, rows, text = 1) {
  line(`| ${head.join(" | ")} |`);
  line(`| ${head.map((_, i) => (i < text ? "---" : "---:")).join(" | ")} |`);
  for (const row of rows) line(`| ${row.join(" | ")} |`);
  line();
}

const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
const run = GITHUB_RUN_ID ? ` ([run](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}))` : "";
line(
  `Filter list refresh by the \`refresh-lists\` workflow${run}. It ran \`npm run update-lists\`, \`npm run build\`, ` +
    "`npm run check` and `npm test` (Safari suite and Chromium suite); all passed.",
);
line();
line(
  `Old → new is the base branch → this branch. Numbers are from \`build-report.json\`; ` +
    'the "Current build" section of README.md is not rewritten by the workflow.',
);
line();

// Versions.
line("### List versions");
line();
const oldLists = byId(oldLock.lists);
const newLists = byId(newLock.lists);
table(
  ["List", "Version", "Last modified", "Mirror commit", "SHA-256"],
  ids(oldLists, newLists).map((id) => {
    const o = oldLists.get(id) ?? {};
    const n = newLists.get(id) ?? {};
    const pair = (a, b) => (a === b ? `${a ?? "–"}` : `${a ?? "–"} → ${b ?? "–"}`);
    return [
      n.title ?? o.title ?? id,
      pair(o.version, n.version),
      pair(o.lastModified, n.lastModified),
      pair(short(o.mirrorCommit), short(n.mirrorCommit)),
      o.sha256 === n.sha256 ? "unchanged" : "changed",
    ];
  }),
  5,
);
const commit = newLock.lists[0]?.mirrorCommit;
if (commit) line(`New pin: https://github.com/easylist/easylist/tree/${commit}`), line();

// Chrome rules and drops.
line("### Chrome rules");
line();
const oldR = byId(oldReport.lists);
const newR = byId(newReport.lists);
const listIds = ids(oldR, newR);
table(
  ["List", "Filters", "Converted", "Cosmetic", "Dropped", "Rules", "Regex rules"],
  listIds.map((id) => {
    const o = oldR.get(id) ?? {};
    const n = newR.get(id) ?? {};
    return [
      n.title ?? o.title ?? id,
      delta(o.filters, n.filters),
      delta(o.convertedFilters, n.convertedFilters),
      delta(o.cosmeticFilters, n.cosmeticFilters),
      delta(o.droppedFilters, n.droppedFilters),
      delta(o.rules, n.rules),
      delta(o.regexRules, n.regexRules),
    ];
  }),
);
line(`Chrome rules in total: ${delta(sum(oldReport.lists, "rules"), sum(newReport.lists, "rules"))}.`);
line();

line("Dropped network filters by reason:");
line();
const dropRows = [];
for (const id of listIds) {
  const o = oldR.get(id)?.droppedByReason ?? {};
  const n = newR.get(id)?.droppedByReason ?? {};
  for (const reason of new Set([...Object.keys(o), ...Object.keys(n)])) {
    dropRows.push([newR.get(id)?.title ?? id, reason, delta(o[reason]?.count ?? 0, n[reason]?.count ?? 0)]);
  }
}
table(["List", "Reason", "Filters"], dropRows, 2);

const oc = oldReport.cosmetic ?? {};
const nc = newReport.cosmetic ?? {};
line(
  `Generic selectors shipped as CSS: ${delta(oc.genericSelectors, nc.genericSelectors)}; ` +
    `CSS bytes: ${delta(oc.cssBytes, nc.cssBytes)}; skipped cosmetic filters: ${delta(oc.skipped, nc.skipped)}.`,
);
line();

// Safari.
line("### Safari");
line();
const oldS = byId(oldReport.safari?.rulesets ?? []);
const newS = byId(newReport.safari?.rulesets ?? []);
table(
  ["Ruleset", "Rules", "Dropped by the Safari transform", "Changed", "Regex rules"],
  ids(oldS, newS).map((id) => {
    const o = oldS.get(id) ?? {};
    const n = newS.get(id) ?? {};
    return [id, delta(o.rules, n.rules), delta(o.dropped, n.dropped), delta(o.changed, n.changed), delta(o.regexRules, n.regexRules)];
  }),
);
const safariRules = (report) => sum(report.safari?.rulesets ?? [], "rules");
line(`Safari rules in total: ${delta(safariRules(oldReport), safariRules(newReport))}.`);
line();
const ob = oldReport.safari?.contentBlockerStats ?? {};
const nb = newReport.safari?.contentBlockerStats ?? {};
table(
  ["Content blocker", "Count"],
  [
    ["Rules", delta(ob.rules, nb.rules)],
    ["Selectors", delta(ob.selectors, nb.selectors)],
    ["Generic selectors", delta(ob.genericSelectors, nb.genericSelectors)],
    ["Site-specific selectors", delta(ob.specificSelectors, nb.specificSelectors)],
    ["Site-specific filters skipped", delta(ob.specificFilters?.skipped, nb.specificFilters?.skipped)],
    ["Bytes", delta(ob.bytes, nb.bytes)],
  ],
);

// Limits.
line("### Limit headroom");
line();
const chromeRules = sum(newReport.lists, "rules");
const chromeRegex = Math.max(0, ...newReport.lists.map((l) => l.regexRules ?? 0));
const safariRegex = Math.max(0, ...(newReport.safari?.rulesets ?? []).map((r) => r.regexRules ?? 0));
const rulesets = newReport.lists.length;
const limitRow = (what, used, limit) => [what, fmt(used), fmt(limit), fmt(limit - used), pct(used, limit)];
table(
  ["What", "Used", "Limit", "Headroom", "Used %"],
  [
    limitRow("Chrome: enabled static rules (guaranteed minimum)", chromeRules, CHROME_LIMITS.GUARANTEED_MINIMUM_STATIC_RULES),
    limitRow("Chrome: regex rules in the largest ruleset", chromeRegex, CHROME_LIMITS.MAX_NUMBER_OF_REGEX_RULES),
    limitRow("Chrome: enabled static rulesets", rulesets, CHROME_LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS),
    limitRow("Safari: regex rules in the largest ruleset", safariRegex, SAFARI_LIMITS.MAX_NUMBER_OF_REGEX_RULES),
    limitRow("Safari: enabled static rulesets", rulesets, SAFARI_LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS),
    limitRow("Safari: content blocker rules", nb.rules ?? 0, SAFARI_LIMITS.CONTENT_BLOCKER_RULES),
  ],
);

line("### Before merging");
line();
line("- Read the `build-report.json` diff for unexpected drops.");
line("- Reload `dist/` in Chrome (and rebuild the Safari app with `safari/package.sh` on the Mac) and look at a test site, as in README \"Sites to test on\".");
line("- Optionally update the README \"Current build\" numbers from the tables above.");

console.log(out.join("\n"));
