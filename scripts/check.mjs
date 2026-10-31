// Checks a built extension against the design invariants (DESIGN.md) and
// the browser's declarativeNetRequest limits. Exits non-zero on any
// violation.
//
//   node scripts/check.mjs [dist]              the Chrome build
//   node scripts/check.mjs --safari [dist-safari]
//
// The Safari build holds the extension in extension/ and the content
// blocker in content-blocker/blockerList.json. The same invariants apply
// (no JavaScript in pages, no network APIs, no remote code, minimum
// permissions), plus: no content scripts and no stylesheets at all (the
// content blocker hides elements, so Safari asks for no site access), no
// chrome:// URL, rulesets limited to the resource types, condition names,
// actions and regex syntax Apple documents for Safari, and a content
// blocker made only of css-display-none and ignore-previous-rules rules
// whose selectors pass the same validator as the Chrome CSS.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  CONTENT_BLOCKER_ACTIONS,
  CONTENT_BLOCKER_DOMAIN,
  CONTENT_BLOCKER_FILE,
  CONTENT_BLOCKER_TRIGGER_KEYS,
  SAFARI_CONDITION_KEYS,
  SAFARI_EXTENSION_DIR,
  SAFARI_LIMITS,
  SAFARI_RESOURCE_TYPES,
  UnsupportedRegex,
  safariRegex,
} from "./safari.mjs";
import { selectorProblem } from "./selector.mjs";

const args = process.argv.slice(2);
const SAFARI = args.includes("--safari");
const ROOT = args.find((arg) => !arg.startsWith("--")) ?? (SAFARI ? "dist-safari" : "dist");
const DIST = SAFARI ? path.join(ROOT, SAFARI_EXTENSION_DIR) : ROOT;
const BROWSER = SAFARI ? "Safari" : "Chrome";

// Chrome limits, from the chrome.declarativeNetRequest API constants.
const CHROME_LIMITS = {
  GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
  MAX_NUMBER_OF_REGEX_RULES: 1_000,
};
const LIMITS = SAFARI ? SAFARI_LIMITS : CHROME_LIMITS;

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
  "action",
  "declarative_net_request",
  // Chrome only: the Safari build has no content scripts at all.
  ...(SAFARI ? [] : ["content_scripts"]),
]);
const ALLOWED_PERMISSIONS = new Set(["declarativeNetRequest", "activeTab"]);
const ALLOWED_ACTION_KEYS = new Set(["default_title", "default_icon", "default_popup"]);
const ALLOWED_ACTIONS = new Set(["block", "allow", "allowAllRequests"]);
// Static rule ids below this are block rules, from here on allow rules
// (assigned by build.mjs, relied on by popup.js).
const FIRST_ALLOW_RULE_ID = 1_000_000;
// Data, stylesheets, documentation, icons, and the extension's own pages.
// The Safari build has no stylesheets.
const ALLOWED_EXTENSIONS = new Set([".json", ".txt", ".png", ".html", ".js", ...(SAFARI ? [] : [".css"])]);
// The only places JavaScript may exist: the popup page and its script. Both
// run in the extension's own page, never in a web page. A background worker
// or a second script is a design change, not a build detail.
const ALLOWED_PAGES = new Set(["popup.html"]);
const ALLOWED_SCRIPTS = new Set(["popup.js"]);
// Browser-internal pages the popup may open in a tab. Not remote: the
// chrome: scheme never leaves the browser. Safari has no such page; its
// popup names none.
const ALLOWED_INTERNAL_URLS = new Set(SAFARI ? [] : ["chrome://extensions/?id="]);
// Content scripts may carry CSS and say where it applies, nothing else.
// "js" is deliberately absent: no JavaScript ever runs in pages.
const ALLOWED_CONTENT_SCRIPT_KEYS = new Set(["matches", "exclude_matches", "css", "run_at", "all_frames"]);
const MATCH_PATTERN = /^(\*|https?):\/\/(\*|(\*\.)?[a-z0-9.-]+)\/[^\s"]*$/;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;
// Anything a script could use to talk to the network, load code, or run
// code in a web page. Matched as whole words anywhere in the file, comments
// and strings included: a script that needs to mention them does not belong.
const FORBIDDEN_IN_SCRIPTS = [
  ["fetch", /\bfetch\b/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["importScripts", /\bimportScripts\b/],
  ["dynamic import()", /\bimport\s*\(/],
  ["import from a URL", /\bimport\b[^;\n]*\bfrom\b[^;\n]*(:\/\/|["'`]\/\/)/],
  ["Worker", /\b(Shared)?Worker\s*\(/],
  ["serviceWorker", /\bserviceWorker\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\b/],
  ["scripting API (code in pages)", /\bscripting\b/],
  ["executeScript (code in pages)", /\bexecuteScript\b/],
  ["insertCSS/removeCSS (code in pages)", /\b(insert|remove)CSS\b/],
  ["registerContentScripts (code in pages)", /\b(register|update)ContentScripts\b/],
  ["userScripts (code in pages)", /\buserScripts\b/],
  ["protocol-relative URL", /["'`]\/\/[a-z0-9]/i],
];
// The only declaration the stylesheets may contain.
const DECLARATION = "{display:none!important}";
// Outside escapes and quoted strings, nothing in a stylesheet or a content
// blocker selector may look like an at-rule, a resource reference or markup.
const FORBIDDEN_IN_CSS = /@|url\(|<|expression\(|behavior:|-moz-binding/i;
// Chrome's condition keys that Safari does not document; the Safari build
// renames them (scripts/safari.mjs).
const CHROME_ONLY_CONDITION_KEYS = ["initiatorDomains", "excludedInitiatorDomains"];

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

// URLs (scheme://...) in a text, except the allowed browser-internal ones.
function remoteUrls(text) {
  return [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)]*/gi)]
    .map((m) => m[0])
    .filter((url) => !ALLOWED_INTERNAL_URLS.has(url));
}

// Escapes and quoted attribute values may contain anything; the rest must not.
const bareCss = (text) => text.replace(/\\./g, "").replace(/"[^"]*"|'[^']*'/g, '""');

const rel = (file) => path.relative(DIST, file).split(path.sep).join("/");
// Chromium writes its ruleset index into _metadata/ when dist/ is loaded
// unpacked; that is Chromium's, not ours.
const files = (await listFiles(DIST)).filter((file) => !rel(file).startsWith("_metadata/"));
const names = new Set(files.map(rel));

// 1. Only known file types, and code only where the design allows it.
for (const file of files) {
  const ext = path.extname(file);
  if (!ALLOWED_EXTENSIONS.has(ext)) fail(`unexpected file type: ${rel(file)}`);
  if (ext === ".js" && !ALLOWED_SCRIPTS.has(rel(file))) fail(`script not allowed: ${rel(file)}`);
  if (ext === ".html" && !ALLOWED_PAGES.has(rel(file))) fail(`page not allowed: ${rel(file)}`);
}

// 2. Manifest: minimum permissions, no remote anything, no code in pages.
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
if (manifest.optional_permissions || manifest.optional_host_permissions) fail("no optional permissions allowed");
if (SAFARI && manifest.content_scripts) fail("no content scripts allowed in the Safari build (the content blocker hides elements)");
walkStrings(manifest, (at, value) => {
  if (!at.startsWith("content_scripts") && URL_PATTERN.test(value)) fail(`URL in manifest at ${at}: ${value}`);
});
for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  if (!file.endsWith(".png") || !names.has(file)) fail(`icons.${size}: missing PNG ${file}`);
}
const action = manifest.action ?? {};
for (const key of Object.keys(action)) {
  if (!ALLOWED_ACTION_KEYS.has(key)) fail(`action key not allowed: ${key}`);
}
for (const [size, file] of Object.entries(action.default_icon ?? {})) {
  if (!file.endsWith(".png") || !names.has(file)) fail(`action.default_icon.${size}: missing PNG ${file}`);
}
if (action.default_popup && !ALLOWED_PAGES.has(action.default_popup)) fail(`action.default_popup must be one of ${[...ALLOWED_PAGES]}`);
if (action.default_popup && !names.has(action.default_popup)) fail(`action.default_popup: missing ${action.default_popup}`);

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
  if (FORBIDDEN_IN_CSS.test(bareCss(text))) fail(`${file}: forbidden text in stylesheet`);
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

// 5. The extension's own pages and scripts: local, self-contained, offline.
// A page may load only the allowed scripts and local images and styles; a
// script may not reach the network, load code, or run code in a web page.
const pages = files.filter((file) => path.extname(file) === ".html").map(rel);
const scripts = files.filter((file) => path.extname(file) === ".js").map(rel);
const referencedScripts = new Set();
for (const page of pages) {
  const html = await readFile(path.join(DIST, page), "utf8");
  for (const url of remoteUrls(html)) fail(`${page}: URL in page: ${url}`);
  if (/["'`]\/\/[a-z0-9]/i.test(html)) fail(`${page}: protocol-relative URL in page`);
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    if (!src) fail(`${page}: inline script`);
    else if (!ALLOWED_SCRIPTS.has(src) || !names.has(src)) fail(`${page}: script not allowed: ${src}`);
    else referencedScripts.add(src);
    if (body.trim()) fail(`${page}: inline script body`);
    if (/\btype\s*=\s*["']module["']/i.test(attributes)) fail(`${page}: module scripts are not allowed (imports)`);
  }
  for (const [, tag] of html.matchAll(/<(link|iframe|frame|object|embed|base|form|audio|video|source)\b/gi)) {
    fail(`${page}: <${tag}> is not allowed`);
  }
  if (/<meta\b[^>]*http-equiv/i.test(html)) fail(`${page}: <meta http-equiv> is not allowed`);
  if (/\son[a-z]+\s*=/i.test(html)) fail(`${page}: inline event handler`);
  for (const [, src] of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi)) {
    if (!src.endsWith(".png") || !names.has(src)) fail(`${page}: image must be a bundled PNG: ${src}`);
  }
  if (/url\(/i.test(html)) fail(`${page}: url() in page styles`);
  if (SAFARI && /\bid="count-row"/.test(html)) fail(`${page}: the Safari popup must not show the blocked count`);
}
let scriptBytes = 0;
for (const script of scripts) {
  const text = await readFile(path.join(DIST, script), "utf8");
  scriptBytes += Buffer.byteLength(text);
  if (!referencedScripts.has(script)) fail(`script not used by any page: ${script}`);
  for (const url of remoteUrls(text)) fail(`${script}: URL in script: ${url}`);
  for (const [name, pattern] of FORBIDDEN_IN_SCRIPTS) {
    const match = pattern.exec(text);
    if (match) fail(`${script}: ${name} is not allowed (at "${match[0].trim()}")`);
  }
  if (SAFARI) {
    for (const key of CHROME_ONLY_CONDITION_KEYS) {
      if (new RegExp(`\\b${key}\\b`).test(text)) fail(`${script}: ${key} is not a condition name Safari documents (it uses domains/excludedDomains)`);
    }
  }
}

// 6. Rulesets: allowed actions only, ids split by action, URLs only as
// match patterns. For Safari also: only documented resource types,
// condition names and regex syntax, and allowAllRequests for main_frame only.
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
  let maxPriority = 0;
  for (const rule of rules) {
    if (!Number.isInteger(rule.id) || rule.id < 1 || ids.has(rule.id)) fail(`${resource.id}: bad or duplicate id ${rule.id}`);
    ids.add(rule.id);
    if (!ALLOWED_ACTIONS.has(rule.action?.type)) fail(`${resource.id}: rule ${rule.id} has action ${rule.action?.type}`);
    if ((rule.action?.type === "block") !== rule.id < FIRST_ALLOW_RULE_ID) {
      fail(`${resource.id}: rule ${rule.id} (${rule.action?.type}) is in the wrong id range`);
    }
    maxPriority = Math.max(maxPriority, rule.priority ?? 1);
    if (rule.condition?.regexFilter) regexRules++;
    walkStrings(rule, (at, value) => {
      if (!URL_PATTERN.test(value)) return;
      if (at === "condition.urlFilter" || at === "condition.regexFilter") patternUrls++;
      else fail(`${resource.id}: URL outside a match pattern in rule ${rule.id} at ${at}: ${value}`);
    });
    if (!SAFARI) continue;
    const condition = rule.condition ?? {};
    for (const key of Object.keys(condition)) {
      if (!SAFARI_CONDITION_KEYS.has(key)) fail(`${resource.id}: rule ${rule.id} uses condition ${key}, which Safari does not document`);
    }
    for (const key of ["resourceTypes", "excludedResourceTypes"]) {
      for (const type of condition[key] ?? []) {
        if (!SAFARI_RESOURCE_TYPES.has(type)) fail(`${resource.id}: rule ${rule.id} ${key} has ${type}, not a resource type in Safari`);
      }
      if (condition[key] && condition[key].length === 0) fail(`${resource.id}: rule ${rule.id} has an empty ${key}`);
    }
    if (rule.action?.type === "allowAllRequests" && JSON.stringify(condition.resourceTypes) !== '["main_frame"]') {
      fail(`${resource.id}: rule ${rule.id} allowAllRequests must be for main_frame only in Safari`);
    }
    if (condition.regexFilter) {
      try {
        if (safariRegex(condition.regexFilter) !== condition.regexFilter) fail(`${resource.id}: rule ${rule.id} regexFilter is not in Safari's regex syntax as written`);
      } catch (error) {
        if (!(error instanceof UnsupportedRegex)) throw error;
        fail(`${resource.id}: rule ${rule.id} regexFilter uses ${error.message}, outside Safari's regex syntax`);
      }
    }
  }
  if (regexRules > LIMITS.MAX_NUMBER_OF_REGEX_RULES) fail(`${resource.id}: ${regexRules} regex rules exceeds ${LIMITS.MAX_NUMBER_OF_REGEX_RULES}`);
  // The popup's switch rule must outrank every static rule.
  if (maxPriority >= 1_000_000) fail(`${resource.id}: priority ${maxPriority} reaches the switch rule's priority`);
  if (resource.enabled) {
    enabledRules += rules.length;
    enabledRulesets++;
  }
  const { size } = await stat(file);
  summary.push({ ruleset: resource.id, enabled: resource.enabled, rules: rules.length, regexRules, patternUrls, maxPriority, bytes: size });
}

// 7. Anything else must be documentation; report any URLs it mentions.
const docUrls = [];
for (const file of files) {
  if (rulesetPaths.has(file) || rel(file) === "manifest.json" || path.extname(file) !== ".txt") continue;
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi)) docUrls.push(`${rel(file)}: ${match[0]}`);
}

// 8. Limits.
const totalRegex = summary.reduce((n, s) => n + s.regexRules, 0);
if (resources.length > LIMITS.MAX_NUMBER_OF_STATIC_RULESETS) fail(`${resources.length} static rulesets exceeds ${LIMITS.MAX_NUMBER_OF_STATIC_RULESETS}`);
if (enabledRulesets > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) fail(`${enabledRulesets} enabled rulesets exceeds ${LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`);
if (!SAFARI && enabledRules > LIMITS.GUARANTEED_MINIMUM_STATIC_RULES) {
  warnings.push(
    `${enabledRules} enabled rules exceeds the guaranteed ${LIMITS.GUARANTEED_MINIMUM_STATIC_RULES}; ` +
      "the rest comes from Chrome's shared global pool and may not be available",
  );
}

// 9. Safari content blocker: css-display-none and ignore-previous-rules only,
// every selector through the validator, domains as lowercase hosts, and the
// order DESIGN.md gives: generic hiding rules, the $generichide ignore rule,
// site-specific hiding rules (if-domain), and at most one more ignore rule
// ($elemhide). A generic rule after the first ignore rule would escape
// $generichide, so after it every hiding rule must carry if-domain.
const blocker = { rules: 0, selectors: 0, genericSelectors: 0, specificSelectors: 0, hideRules: 0, specificRules: 0, ignoreRules: 0, bytes: 0 };
if (SAFARI) {
  const file = path.join(ROOT, CONTENT_BLOCKER_FILE);
  const text = await readFile(file, "utf8");
  blocker.bytes = Buffer.byteLength(text);
  const rules = JSON.parse(text);
  if (!Array.isArray(rules) || rules.length === 0) fail(`${CONTENT_BLOCKER_FILE}: must be a non-empty array of rules`);
  let ignoresSeen = 0;
  for (const [index, rule] of (Array.isArray(rules) ? rules : []).entries()) {
    const where = `${CONTENT_BLOCKER_FILE} rule ${index}`;
    blocker.rules++;
    if (JSON.stringify(Object.keys(rule).sort()) !== '["action","trigger"]') fail(`${where}: keys must be trigger and action`);
    const trigger = rule.trigger ?? {};
    for (const key of Object.keys(trigger)) {
      if (!CONTENT_BLOCKER_TRIGGER_KEYS.has(key)) fail(`${where}: trigger key not allowed: ${key}`);
    }
    if (trigger["url-filter"] !== ".*") fail(`${where}: url-filter must be ".*" (hiding is decided by domain only)`);
    if (trigger["if-domain"] && trigger["unless-domain"]) fail(`${where}: if-domain and unless-domain together`);
    for (const key of ["if-domain", "unless-domain"]) {
      const domains = trigger[key];
      if (domains === undefined) continue;
      if (!Array.isArray(domains) || domains.length === 0) fail(`${where}: ${key} must be a non-empty array`);
      for (const domain of domains ?? []) {
        if (typeof domain !== "string" || !CONTENT_BLOCKER_DOMAIN.test(domain)) fail(`${where}: bad domain in ${key}: ${domain}`);
      }
    }
    const type = rule.action?.type;
    if (!CONTENT_BLOCKER_ACTIONS.has(type)) fail(`${where}: action not allowed: ${type}`);
    const actionKeys = Object.keys(rule.action ?? {}).sort().join(",");
    if (type === "css-display-none") {
      blocker.hideRules++;
      const specific = Boolean(trigger["if-domain"]);
      if (specific) blocker.specificRules++;
      if (ignoresSeen === 0 && specific) fail(`${where}: site-specific hiding rule before the $generichide ignore rule, which would cancel it`);
      if (ignoresSeen === 1 && !specific) fail(`${where}: generic hiding rule after the $generichide ignore rule, which would not cancel it`);
      if (ignoresSeen > 1) fail(`${where}: hiding rule after the last ignore rule`);
      if (actionKeys !== "selector,type") fail(`${where}: css-display-none action must have exactly type and selector`);
      const selector = rule.action.selector;
      if (typeof selector !== "string" || !selector.trim()) fail(`${where}: selector missing`);
      else {
        if (FORBIDDEN_IN_CSS.test(bareCss(selector))) fail(`${where}: forbidden text in selector`);
        const problem = selectorProblem(selector);
        if (problem) fail(`${where}: ${problem}: ${selector.slice(0, 80)}`);
        const count = selector.split(",").length;
        blocker.selectors += count;
        if (specific) blocker.specificSelectors += count;
        else blocker.genericSelectors += count;
      }
    } else if (type === "ignore-previous-rules") {
      blocker.ignoreRules++;
      ignoresSeen++;
      if (ignoresSeen > 2) fail(`${where}: more than two ignore-previous-rules rules`);
      if (actionKeys !== "type") fail(`${where}: ignore-previous-rules action must have only a type`);
      if (!trigger["if-domain"]) fail(`${where}: ignore-previous-rules must be limited by if-domain`);
    }
  }
  if (blocker.rules > LIMITS.CONTENT_BLOCKER_RULES) fail(`${blocker.rules} content blocker rules exceeds ${LIMITS.CONTENT_BLOCKER_RULES}`);
}

console.table(summary);
console.log(`${BROWSER} build in ${DIST}`);
console.log(`Files: ${files.length} (${cssFiles.size} stylesheets, ${pages.length} page, ${scripts.length} script)`);
console.log(`Permissions: ${JSON.stringify(manifest.permissions ?? [])}`);
console.log(
  SAFARI
    ? "Content scripts: none (no site access); element hiding is the content blocker"
    : `Content scripts: ${contentScripts.length} entries, CSS only (no js key anywhere), ` +
        `${contentScripts.filter((e) => e.matches?.includes("<all_urls>")).length} on all URLs`,
);
if (!SAFARI) console.log(`Stylesheets: ${cssRules} rules, ${cssSelectors} selectors, ${cssBytes} bytes, every declaration is ${DECLARATION}`);
console.log(
  `Scripts: ${scripts.join(", ") || "none"} (${scriptBytes} bytes), loaded only by ${pages.join(", ") || "no page"}; ` +
    "no network API, no remote URL, no code in pages, no background worker",
);
if (SAFARI) {
  console.log(`Enabled static rules: ${enabledRules} in ${enabledRulesets} rulesets (Safari: ${LIMITS.MAX_NUMBER_OF_STATIC_RULESETS} rulesets, ${LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS} enabled)`);
  console.log(
    `Content blocker: ${blocker.rules} rules (${blocker.hideRules - blocker.specificRules} generic css-display-none, ` +
      `${blocker.specificRules} site-specific, ${blocker.ignoreRules} ignore-previous-rules), ${blocker.selectors} selectors ` +
      `(${blocker.genericSelectors} generic, ${blocker.specificSelectors} site-specific), ${blocker.bytes} bytes; limit ${LIMITS.CONTENT_BLOCKER_RULES} rules ` +
      `(${((blocker.rules / LIMITS.CONTENT_BLOCKER_RULES) * 100).toFixed(1)}% used)`,
  );
} else {
  console.log(
    `Enabled static rules: ${enabledRules} of ${LIMITS.GUARANTEED_MINIMUM_STATIC_RULES} guaranteed ` +
      `(${(LIMITS.GUARANTEED_MINIMUM_STATIC_RULES - enabledRules).toLocaleString("en")} headroom, ` +
      `${((enabledRules / LIMITS.GUARANTEED_MINIMUM_STATIC_RULES) * 100).toFixed(1)}% used)`,
  );
}
console.log(`Regex rules: ${totalRegex} in total (limit ${LIMITS.MAX_NUMBER_OF_REGEX_RULES} per ruleset)`);
console.log(`Rulesets: ${resources.length} static, ${enabledRulesets} enabled; block rule ids < ${FIRST_ALLOW_RULE_ID} <= allow rule ids`);
console.log(`URLs in documentation files (never loaded): ${docUrls.length ? "\n  " + docUrls.join("\n  ") : "none"}`);
for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (errors.length) {
  console.error(`FAILED:\n  ${errors.slice(0, 30).join("\n  ")}${errors.length > 30 ? `\n  ... ${errors.length - 30} more` : ""}`);
  process.exit(1);
}
console.log(
  SAFARI
    ? "OK: JavaScript only in the popup, no network APIs, no remote URLs outside match patterns, no content scripts, minimum permissions, Safari rule syntax, within limits"
    : "OK: JavaScript only in the popup, no network APIs, no remote URLs outside match patterns, minimum permissions, within limits",
);
