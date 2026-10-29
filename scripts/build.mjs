// Builds dist/ from src/ plus the filter lists pinned in lists.lock.json,
// then dist-safari/ from dist/ (scripts/safari.mjs). Output depends only on
// the pinned list bytes, src/ and the locked npm dependencies, so rebuilding
// from the same pins gives identical files.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { buildCosmetic } from "./cosmetic.mjs";
import { loadPinned } from "./fetch.mjs";
import { LOCK_FILE } from "./lists.mjs";
import { assertMergeEquivalent, mergeHostRules } from "./merge.mjs";
import { SAFARI_DIST, buildSafari } from "./safari.mjs";

const require = createRequire(import.meta.url);
const { convertFilter } = require("@eyeo/abp2dnr");
// abp2dnr's own parser, used only to say why a filter was not converted.
const { Filter } = require("@eyeo/webext-ad-filtering-solution/adblockpluscore/lib/filterClasses.js");

const SRC = "src";
const DIST = "dist";
const REPORT = "build-report.json";
const EXAMPLES_PER_REASON = 3;

// Actions that work with the bare "declarativeNetRequest" permission.
// redirect and modifyHeaders would need host permissions, so they are dropped.
const ALLOWED_ACTIONS = new Set(["block", "allow", "allowAllRequests"]);
// Static rule ids below this are block rules, from here on allow rules. The
// same constant lives in src/popup.js and scripts/check.mjs.
const FIRST_ALLOW_RULE_ID = 1_000_000;

// Cosmetic filters go to scripts/cosmetic.mjs, which turns them into CSS.
const COSMETIC_TYPES = new Set(["elemhide", "elemhideexception", "elemhideemulation", "snippet"]);
// Also catches uBO/AdGuard cosmetic syntax that the ABP parser rejects as invalid.
const COSMETIC_SEPARATOR = /^[^/|$]*#@?[?$]?#/;
// Network exceptions that switch cosmetic filters off on a site.
const HIDING_EXCEPTION = /(^|,)(generichide|ghide|elemhide|ehide)(=|,|$)/;

const CONVERTER_ERRORS = {
  filter_invalid_regexp: "regex rejected by RE2/isRegexSupported limits",
  filter_invalid_rewrite: "unsupported $rewrite resource",
  filter_unknown_option: "unsupported option",
};

function emptyResultReason(text) {
  const options = text.includes("$") ? text.slice(text.lastIndexOf("$") + 1).toLowerCase() : "";
  const has = (pattern) => new RegExp(`(^|,)(${pattern})(=|,|$)`).test(options);
  if (has("popup")) return "$popup has no declarativeNetRequest equivalent";
  if (has("genericblock")) return "$genericblock has no declarativeNetRequest equivalent";
  if (has("document|doc")) return "$document page block (abp2dnr does not convert it)";
  if (/(^|,)domain=[^,]*\*/.test(options)) return "wildcard in $domain is not supported";
  return "no rule generated";
}

async function convertList(text) {
  const rules = [];
  const cosmetic = [];
  const seen = new Set();
  const dropped = new Map();
  const stats = { filters: 0, comments: 0, convertedFilters: 0, cosmeticFilters: 0, droppedFilters: 0, duplicateRules: 0 };

  const drop = (reason, filter) => {
    const entry = dropped.get(reason) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < EXAMPLES_PER_REASON) entry.examples.push(filter);
    dropped.set(reason, entry);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^\[Adblock Plus [\d.]+\]$/i.test(line)) continue;

    const filter = Filter.fromText(Filter.normalize(line));
    if (filter.type === "comment") {
      stats.comments++;
      continue;
    }
    stats.filters++;

    if (COSMETIC_TYPES.has(filter.type) || (filter.type === "invalid" && COSMETIC_SEPARATOR.test(line))) {
      cosmetic.push({ line, filter });
      stats.cosmeticFilters++;
      continue;
    }
    const options = line.includes("$") ? line.slice(line.lastIndexOf("$") + 1).toLowerCase() : "";
    const hidingException = filter.type === "allowing" && HIDING_EXCEPTION.test(options);
    if (hidingException) {
      cosmetic.push({ line, filter });
      stats.cosmeticFilters++;
    }
    if (filter.type === "invalid") {
      const reason = filter.option ? `unsupported option $${filter.option}` : `invalid filter (${filter.reason})`;
      drop(reason, line);
      stats.droppedFilters++;
      continue;
    }

    let converted;
    try {
      converted = await convertFilter(line);
    } catch (error) {
      const option = error.detail?.option ? ` $${error.detail.option}` : "";
      drop(`${CONVERTER_ERRORS[error.message] ?? error.message}${option}`, line);
      stats.droppedFilters++;
      continue;
    }

    if (converted.length === 0) {
      // A pure $generichide/$elemhide exception is handled as CSS above.
      if (!hidingException) {
        drop(emptyResultReason(line), line);
        stats.droppedFilters++;
      }
      continue;
    }

    let kept = 0;
    let unsupportedAction = null;
    for (const rule of converted) {
      if (!ALLOWED_ACTIONS.has(rule.action.type)) {
        unsupportedAction = rule.action.type;
        continue;
      }
      kept++;
      const key = JSON.stringify(rule);
      if (seen.has(key)) {
        stats.duplicateRules++;
        continue;
      }
      seen.add(key);
      rules.push(rule);
    }
    if (unsupportedAction) {
      const partly = kept > 0 ? " (its other rules were kept)" : "";
      drop(`${unsupportedAction} action needs host permissions${partly}`, line);
    }
    if (kept > 0) stats.convertedFilters++;
    else stats.droppedFilters++;
  }

  const merged = mergeHostRules(rules);
  assertMergeEquivalent(rules, merged, "ruleset");
  stats.rulesBeforeMerge = rules.length;
  // Ids are assigned last so they are dense and stable.
  // Ids say what a rule does: block rules count up from 1, allow rules from
  // FIRST_ALLOW_RULE_ID. The popup counts blocked requests from matched rule
  // ids alone (it has no other way to read a static rule), and check.mjs
  // verifies the split. Order within each group follows the list.
  const blocks = merged.filter((rule) => rule.action.type === "block");
  const allows = merged.filter((rule) => rule.action.type !== "block");
  const ruleset = [
    ...blocks.map((rule, index) => ({ id: index + 1, ...rule })),
    ...allows.map((rule, index) => ({ id: FIRST_ALLOW_RULE_ID + index, ...rule })),
  ];
  const droppedByReason = Object.fromEntries(
    [...dropped.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])),
  );
  return { ruleset, cosmetic, stats, droppedByReason };
}

// One rule per line keeps list updates diffable.
function serializeRuleset(ruleset) {
  return "[\n" + ruleset.map((rule) => JSON.stringify(rule)).join(",\n") + "\n]\n";
}

// Likewise one content_scripts entry per line; there are thousands.
function serializeManifest(manifest) {
  const { content_scripts: contentScripts, ...rest } = manifest;
  const entries = contentScripts.map((entry) => "    " + JSON.stringify(entry)).join(",\n");
  return JSON.stringify(rest, null, 2).replace(/\n}$/, `,\n  "content_scripts": [\n${entries}\n  ]\n}\n`);
}

const lock = JSON.parse(await readFile(LOCK_FILE, "utf8"));
const manifest = JSON.parse(await readFile(path.join(SRC, "manifest.json"), "utf8"));
const resources = manifest.declarative_net_request.rule_resources;

const lockedIds = lock.lists.map((list) => list.id).sort();
const manifestIds = resources.map((resource) => resource.id).sort();
if (JSON.stringify(lockedIds) !== JSON.stringify(manifestIds)) {
  throw new Error(`Rulesets in src/manifest.json (${manifestIds}) do not match ${LOCK_FILE} (${lockedIds})`);
}

await rm(DIST, { recursive: true, force: true });
await cp(SRC, DIST, { recursive: true });

const report = { extensionVersion: manifest.version, lists: [] };
const cosmeticFilters = [];
const rulesets = new Map();

for (const list of lock.lists) {
  const text = (await loadPinned(list)).toString("utf8");
  const { ruleset, cosmetic, stats, droppedByReason } = await convertList(text);
  cosmeticFilters.push(...cosmetic);
  rulesets.set(list.id, ruleset);
  const resource = resources.find((r) => r.id === list.id);
  const outPath = path.join(DIST, resource.path);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeRuleset(ruleset));

  const regexRules = ruleset.filter((rule) => rule.condition.regexFilter).length;
  report.lists.push({
    id: list.id,
    title: list.title,
    version: list.version,
    sha256: list.sha256,
    rulesetPath: resource.path,
    ...stats,
    rules: ruleset.length,
    regexRules,
    droppedByReason,
  });
  console.log(
    `${list.id}: ${stats.filters} filters, ${stats.convertedFilters} converted, ${stats.cosmeticFilters} cosmetic, ` +
      `${stats.droppedFilters} dropped -> ${stats.rulesBeforeMerge} rules, ${ruleset.length} after merging host-only rules ` +
      `(${regexRules} regex); merge check passed`,
  );
}

// Cosmetic filters from all lists are handled together, because an
// exception in one list applies to the filters of every list.
const { files, contentScripts, details: cosmeticDetails, stats: cosmeticStats } = buildCosmetic(cosmeticFilters);
for (const [file, css] of files) {
  const outPath = path.join(DIST, file);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, css);
}
manifest.content_scripts = contentScripts;
await writeFile(path.join(DIST, "manifest.json"), serializeManifest(manifest));
report.cosmetic = cosmeticStats;
console.log(
  `cosmetic: ${cosmeticStats.filters} filters, ${cosmeticStats.used} used, ${cosmeticStats.skipped} skipped -> ` +
    `${cosmeticStats.genericSelectors} generic selectors in ${cosmeticStats.files} CSS files ` +
    `(${cosmeticStats.cssBytes} bytes), ${cosmeticStats.contentScripts} content_scripts entries`,
);

// Safari: the same extension, transformed where Apple's documentation says
// Safari differs, plus a native content blocker in place of the CSS.
report.safari = await buildSafari({ dist: DIST, manifest, rulesets, cosmetic: cosmeticDetails });
for (const r of report.safari.rulesets) {
  console.log(`safari ${r.id}: ${r.rules} rules (${r.changed} changed, ${r.dropped} dropped, ${r.regexRules} regex)`);
}
const cb = report.safari.contentBlockerStats;
console.log(
  `safari content blocker: ${cb.rules} rules for ${cb.selectors} selectors (${cb.genericRules} generic, ` +
    `${cb.exceptionRules} with exceptions in ${cb.exceptionGroups} domain sets, ${cb.ignoreRules} ignore rule for ` +
    `${cb.hidingOffDomains} domains; ${cb.bytes} bytes)`,
);

await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${DIST}/, ${SAFARI_DIST}/ and ${REPORT}`);
