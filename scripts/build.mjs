// Builds dist/ from src/ plus the filter lists pinned in lists.lock.json.
// Output depends only on the pinned list bytes, src/ and the locked npm
// dependencies, so rebuilding from the same pins gives identical files.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { loadPinned } from "./fetch.mjs";
import { LOCK_FILE } from "./lists.mjs";

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

const COSMETIC_TYPES = new Set(["elemhide", "elemhideexception", "elemhideemulation", "snippet"]);
// Also catches uBO/AdGuard cosmetic syntax that the ABP parser rejects as invalid.
const COSMETIC_SEPARATOR = /^[^/|$]*#@?[?$]?#/;

const CONVERTER_ERRORS = {
  filter_invalid_regexp: "regex rejected by RE2/isRegexSupported limits",
  filter_invalid_rewrite: "unsupported $rewrite resource",
  filter_unknown_option: "unsupported option",
};

function emptyResultReason(text) {
  const options = text.includes("$") ? text.slice(text.lastIndexOf("$") + 1).toLowerCase() : "";
  const has = (pattern) => new RegExp(`(^|,)(${pattern})(=|,|$)`).test(options);
  if (has("popup")) return "$popup has no declarativeNetRequest equivalent";
  if (has("elemhide|ehide|generichide|ghide")) return "cosmetic exception (needs content scripts)";
  if (has("genericblock")) return "$genericblock has no declarativeNetRequest equivalent";
  if (has("document|doc")) return "$document page block (abp2dnr does not convert it)";
  if (/(^|,)domain=[^,]*\*/.test(options)) return "wildcard in $domain is not supported";
  return "no rule generated";
}

// "||example.com^" matches example.com and its subdomains on any path, which
// is exactly what requestDomains matches. Rules that differ only in that host
// are folded into one rule listing all the hosts. This keeps the total well
// inside Chrome's guaranteed static rule count without changing what matches.
const HOST_ONLY = /^\|\|((?:[a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*)\^$/;
const MERGEABLE_ACTIONS = new Set(["block", "allow"]);
const MERGEABLE_KEYS = new Set([
  "urlFilter",
  "domainType",
  "resourceTypes",
  "excludedResourceTypes",
  "initiatorDomains",
  "excludedInitiatorDomains",
  "requestMethods",
  "excludedRequestMethods",
]);

function canonical(object) {
  return JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))));
}

function mergeHostRules(rules) {
  const out = [];
  const groups = new Map();
  for (const rule of rules) {
    const host = HOST_ONLY.exec(rule.condition.urlFilter ?? "")?.[1];
    const mergeable =
      host && MERGEABLE_ACTIONS.has(rule.action.type) && Object.keys(rule.condition).every((key) => MERGEABLE_KEYS.has(key));
    if (!mergeable) {
      out.push(rule);
      continue;
    }
    const { urlFilter, ...rest } = rule.condition;
    const key = `${rule.priority}|${canonical(rule.action)}|${canonical(rest)}`;
    let group = groups.get(key);
    if (!group) {
      group = { hosts: new Set(), rule: { priority: rule.priority, condition: rest, action: rule.action } };
      groups.set(key, group);
      out.push(group.rule);
    }
    group.hosts.add(host);
  }
  for (const { hosts, rule } of groups.values()) {
    const [first] = hosts;
    rule.condition =
      hosts.size === 1
        ? { urlFilter: `||${first}^`, ...rule.condition }
        : { ...rule.condition, requestDomains: [...hosts].sort() };
  }
  return out;
}

async function convertList(text) {
  const rules = [];
  const seen = new Set();
  const dropped = new Map();
  const stats = { filters: 0, comments: 0, convertedFilters: 0, droppedFilters: 0, duplicateRules: 0 };

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
      drop("cosmetic filter (needs content scripts)", line);
      stats.droppedFilters++;
      continue;
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
      drop(emptyResultReason(line), line);
      stats.droppedFilters++;
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
  stats.rulesBeforeMerge = rules.length;
  // Ids are assigned last so they are dense and stable.
  const ruleset = merged.map((rule, index) => ({ id: index + 1, ...rule }));
  const droppedByReason = Object.fromEntries(
    [...dropped.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])),
  );
  return { ruleset, stats, droppedByReason };
}

// One rule per line keeps list updates diffable.
function serializeRuleset(ruleset) {
  return "[\n" + ruleset.map((rule) => JSON.stringify(rule)).join(",\n") + "\n]\n";
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

for (const list of lock.lists) {
  const text = (await loadPinned(list)).toString("utf8");
  const { ruleset, stats, droppedByReason } = await convertList(text);
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
    `${list.id}: ${stats.filters} filters, ${stats.convertedFilters} converted, ${stats.droppedFilters} dropped -> ` +
      `${stats.rulesBeforeMerge} rules, ${ruleset.length} after merging host-only rules (${regexRules} regex)`,
  );
}

await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${DIST}/ and ${REPORT}`);
