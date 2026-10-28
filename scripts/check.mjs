// Checks dist/ against the design invariants (DESIGN.md) and Chrome's
// declarativeNetRequest limits. Exits non-zero on any violation.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { selectorProblem } from "./selector.mjs";

const DIST = process.argv[2] ?? "dist";

// Chrome limits, from the chrome.declarativeNetRequest API constants.
const LIMITS = {
  GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
  MAX_NUMBER_OF_REGEX_RULES: 1_000,
};

// Every manifest key and permission is an explicit decision. Adding one
// means updating this list, and DESIGN.md says why it is needed.
const ALLOWED_MANIFEST_KEYS = new Set([
  "manifest_version",
  "name",
  "version",
  "description",
  "minimum_chrome_version",
  "icons",
  "permissions",
  "declarative_net_request",
  "content_scripts",
]);
const ALLOWED_PERMISSIONS = new Set(["declarativeNetRequest"]);
const ALLOWED_ACTIONS = new Set(["block", "allow", "allowAllRequests"]);
// Data, stylesheets and documentation only: nothing the browser can execute.
const ALLOWED_EXTENSIONS = new Set([".json", ".txt", ".png", ".css"]);
// Content scripts may carry CSS and say where it applies, nothing else.
// "js" is deliberately absent: no JavaScript ever runs in pages.
const ALLOWED_CONTENT_SCRIPT_KEYS = new Set(["matches", "exclude_matches", "css", "run_at", "all_frames"]);
const MATCH_PATTERN = /^(\*|https?):\/\/(\*|(\*\.)?[a-z0-9.-]+)\/[^\s"]*$/;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;
// The only declaration the stylesheets may contain.
const DECLARATION = "{display:none!important}";

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files.sort();
}

// Calls visit(pathString, value) for every string in a JSON value.
function walkStrings(value, visit, at = "") {
  if (typeof value === "string") visit(at, value);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, `${at}[${i}]`));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, visit, at ? `${at}.${k}` : k);
  }
}

const rel = (file) => path.relative(DIST, file).split(path.sep).join("/");
// Chromium writes its ruleset index into _metadata/ when dist/ is loaded
// unpacked; that is Chromium's, not ours.
const files = (await listFiles(DIST)).filter((file) => !rel(file).startsWith("_metadata/"));

// 1. Only data files: no scripts, pages or wasm that could run.
for (const file of files) {
  if (!ALLOWED_EXTENSIONS.has(path.extname(file))) fail(`unexpected file type: ${rel(file)}`);
}

// 2. Manifest: minimum permissions, no remote anything, no code.
const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
for (const key of Object.keys(manifest)) {
  if (!ALLOWED_MANIFEST_KEYS.has(key)) fail(`manifest key not allowed: ${key}`);
}
for (const permission of manifest.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.has(permission)) fail(`permission not allowed: ${permission}`);
}
if (manifest.background) fail("no background scripts allowed");
if (manifest.host_permissions) fail("no host permissions allowed");
walkStrings(manifest, (at, value) => {
  if (!at.startsWith("content_scripts") && URL_PATTERN.test(value)) fail(`URL in manifest at ${at}: ${value}`);
});

// 3. Content scripts: CSS only, applied by match patterns, no JavaScript.
const cssFiles = new Set(files.filter((file) => path.extname(file) === ".css").map(rel));
const referencedCss = new Map();
const contentScripts = manifest.content_scripts ?? [];
for (const [index, entry] of contentScripts.entries()) {
  const where = `content_scripts[${index}]`;
  for (const key of Object.keys(entry)) {
    if (key === "js") fail(`${where}: JavaScript in pages is not allowed (js: ${JSON.stringify(entry.js)})`);
    else if (!ALLOWED_CONTENT_SCRIPT_KEYS.has(key)) fail(`${where}: key not allowed: ${key}`);
  }
  if (!Array.isArray(entry.matches) || entry.matches.length === 0) fail(`${where}: matches missing`);
  for (const pattern of [...(entry.matches ?? []), ...(entry.exclude_matches ?? [])]) {
    if (pattern !== "<all_urls>" && !MATCH_PATTERN.test(pattern)) fail(`${where}: bad match pattern ${pattern}`);
  }
  if (!Array.isArray(entry.css) || entry.css.length === 0) fail(`${where}: css missing`);
  for (const file of entry.css ?? []) {
    if (!file.endsWith(".css")) fail(`${where}: not a stylesheet: ${file}`);
    if (!cssFiles.has(file)) fail(`${where}: missing file ${file}`);
    referencedCss.set(file, (referencedCss.get(file) ?? 0) + 1);
  }
}
for (const file of cssFiles) {
  if (!referencedCss.has(file)) fail(`stylesheet not used by any content script: ${file}`);
}

// 4. Stylesheets: nothing but selectors and "display:none!important". The
// selector validator rejects url(), braces and comments, so a stylesheet
// cannot reference, load or run anything.
let cssRules = 0;
let cssSelectors = 0;
let cssBytes = 0;
for (const file of [...cssFiles].sort()) {
  const text = await readFile(path.join(DIST, file), "utf8");
  cssBytes += Buffer.byteLength(text);
  // Escapes and quoted attribute values may contain anything; outside them
  // nothing may look like an at-rule, a resource reference or markup.
  const bare = text.replace(/\\./g, "").replace(/"[^"]*"|'[^']*'/g, '""');
  if (/@|url\(|<|expression\(|behavior:|-moz-binding/i.test(bare)) fail(`${file}: forbidden text in stylesheet`);
  const rules = text.split(DECLARATION);
  if (rules.pop().trim() !== "") fail(`${file}: text after the last rule`);
  for (const rule of rules) {
    cssRules++;
    const selectors = rule.trim();
    const problem = selectorProblem(selectors);
    if (problem) fail(`${file}: ${problem}: ${selectors.slice(0, 80)}`);
    cssSelectors += selectors.split(",\n").length;
  }
}

// 5. Rulesets: allowed actions only; URLs may appear only as match patterns.
const resources = manifest.declarative_net_request?.rule_resources ?? [];
const rulesetPaths = new Set(resources.map((r) => path.join(DIST, r.path)));
const summary = [];
let enabledRules = 0;
let enabledRulesets = 0;

for (const resource of resources) {
  const file = path.join(DIST, resource.path);
  const rules = JSON.parse(await readFile(file, "utf8"));
  const ids = new Set();
  let regexRules = 0;
  let patternUrls = 0;
  for (const rule of rules) {
    if (!Number.isInteger(rule.id) || rule.id < 1 || ids.has(rule.id)) fail(`${resource.id}: bad or duplicate id ${rule.id}`);
    ids.add(rule.id);
    if (!ALLOWED_ACTIONS.has(rule.action?.type)) fail(`${resource.id}: rule ${rule.id} has action ${rule.action?.type}`);
    if (rule.condition?.regexFilter) regexRules++;
    walkStrings(rule, (at, value) => {
      if (!URL_PATTERN.test(value)) return;
      if (at === "condition.urlFilter" || at === "condition.regexFilter") patternUrls++;
      else fail(`${resource.id}: URL outside a match pattern in rule ${rule.id} at ${at}: ${value}`);
    });
  }
  if (regexRules > LIMITS.MAX_NUMBER_OF_REGEX_RULES) fail(`${resource.id}: ${regexRules} regex rules exceeds ${LIMITS.MAX_NUMBER_OF_REGEX_RULES}`);
  if (resource.enabled) {
    enabledRules += rules.length;
    enabledRulesets++;
  }
  const { size } = await stat(file);
  summary.push({ ruleset: resource.id, enabled: resource.enabled, rules: rules.length, regexRules, patternUrls, bytes: size });
}

// 6. Anything else must be documentation; report any URLs it mentions.
const docUrls = [];
for (const file of files) {
  if (rulesetPaths.has(file) || rel(file) === "manifest.json" || path.extname(file) !== ".txt") continue;
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi)) docUrls.push(`${rel(file)}: ${match[0]}`);
}

// 7. Chrome limits.
const totalRegex = summary.reduce((n, s) => n + s.regexRules, 0);
if (resources.length > LIMITS.MAX_NUMBER_OF_STATIC_RULESETS) fail(`${resources.length} static rulesets exceeds ${LIMITS.MAX_NUMBER_OF_STATIC_RULESETS}`);
if (enabledRulesets > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) fail(`${enabledRulesets} enabled rulesets exceeds ${LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`);
if (enabledRules > LIMITS.GUARANTEED_MINIMUM_STATIC_RULES) {
  warnings.push(
    `${enabledRules} enabled rules exceeds the guaranteed ${LIMITS.GUARANTEED_MINIMUM_STATIC_RULES}; ` +
      "the rest comes from Chrome's shared global pool and may not be available",
  );
}

console.table(summary);
console.log(`Files: ${files.length} (${cssFiles.size} stylesheets)`);
console.log(`Permissions: ${JSON.stringify(manifest.permissions ?? [])}`);
console.log(
  `Content scripts: ${contentScripts.length} entries, CSS only (no js key anywhere), ` +
    `${contentScripts.filter((e) => e.matches?.includes("<all_urls>")).length} on all URLs`,
);
console.log(`Stylesheets: ${cssRules} rules, ${cssSelectors} selectors, ${cssBytes} bytes, every declaration is ${DECLARATION}`);
console.log(
  `Enabled static rules: ${enabledRules} of ${LIMITS.GUARANTEED_MINIMUM_STATIC_RULES} guaranteed ` +
    `(${(LIMITS.GUARANTEED_MINIMUM_STATIC_RULES - enabledRules).toLocaleString("en")} headroom, ` +
    `${((enabledRules / LIMITS.GUARANTEED_MINIMUM_STATIC_RULES) * 100).toFixed(1)}% used)`,
);
console.log(`Regex rules: ${totalRegex} in total (limit ${LIMITS.MAX_NUMBER_OF_REGEX_RULES} per ruleset)`);
console.log(`Rulesets: ${resources.length} static, ${enabledRulesets} enabled`);
console.log(`URLs in documentation files (never loaded): ${docUrls.length ? "\n  " + docUrls.join("\n  ") : "none"}`);
for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (errors.length) {
  console.error(`FAILED:\n  ${errors.slice(0, 30).join("\n  ")}${errors.length > 30 ? `\n  ... ${errors.length - 30} more` : ""}`);
  process.exit(1);
}
console.log("OK: no executable files, no JavaScript in pages, no remote URLs outside match patterns, minimum permissions, within limits");
