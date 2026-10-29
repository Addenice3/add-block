// Builds dist-safari/ from the Chrome build: the same extension with the
// rulesets transformed where Apple's documentation says Safari differs, the
// element-hiding CSS replaced by a native Safari content blocker, and the
// popup without the blocked count and the chrome:// link. dist/ is never
// changed; everything here derives from it in memory.
//
// Sources (developer.apple.com; webkit.org was not reachable from the build
// environment):
//   Blocking content with your Safari web extension
//     /documentation/safariservices/blocking-content-with-your-safari-web-extension
//   Creating a content blocker (rule and trigger syntax, regex subset)
//     /documentation/safariservices/creating-a-content-blocker
//   Safari release notes 15.4, 16, 16.4, 17.2, 18.6, 26
//     /documentation/safari-release-notes
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// What Safari accepts, per Apple's documentation.

// "Safari supports main_frame, sub_frame, stylesheet, script, image, font,
// xmlhttprequest, ping, media, websocket, and other." Chrome's csp_report,
// object and webbundle are not in that list.
export const SAFARI_RESOURCE_TYPES = new Set([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
]);

// Condition keys allowed in the Safari rulesets. Apple's Safari 17.2 release
// notes name the domain conditions "domains, requestDomains, excludedDomains,
// and excludedRequestDomains" (16.4 added requestDomains); Chrome's newer
// names initiatorDomains/excludedInitiatorDomains appear in no Apple
// document, so the build renames them. The others are from "Blocking content
// with your Safari web extension".
export const SAFARI_CONDITION_KEYS = new Set([
  "urlFilter",
  "regexFilter",
  "isUrlFilterCaseSensitive",
  "resourceTypes",
  "excludedResourceTypes",
  "domainType",
  "domains",
  "excludedDomains",
  "requestDomains",
  "excludedRequestDomains",
]);
const RENAMED_CONDITION_KEYS = { initiatorDomains: "domains", excludedInitiatorDomains: "excludedDomains" };

export const SAFARI_LIMITS = {
  // Safari 16 release notes: "Updated the maximum number of static rulesets
  // to 50 and the maximum number of enabled static rulesets to 10."
  MAX_NUMBER_OF_STATIC_RULESETS: 50,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 10,
  // Not stated in any Apple document reachable from the build environment.
  // WebKit raised the content blocker limit from 50,000 to 150,000 rules per
  // list with Safari 15 (from memory, unverified); the lower figure is used.
  CONTENT_BLOCKER_RULES: 50_000,
  // Safari documents no regex rule limit; Chrome's per-ruleset limit is kept.
  MAX_NUMBER_OF_REGEX_RULES: 1_000,
};

// Content blocker rules: the only shapes the build writes and the check
// accepts. "trigger": url-filter ".*" with an optional domain condition;
// "action": css-display-none with a selector, or ignore-previous-rules.
export const CONTENT_BLOCKER_TRIGGER_KEYS = new Set(["url-filter", "if-domain", "unless-domain"]);
export const CONTENT_BLOCKER_ACTIONS = new Set(["css-display-none", "ignore-previous-rules"]);
export const CONTENT_BLOCKER_DOMAIN = /^\*?(?:[a-z0-9-]+\.)*[a-z0-9-]+$/;
// Same grouping as the CSS (scripts/cosmetic.mjs).
const SELECTORS_PER_RULE = 100;

// ---------------------------------------------------------------------------
// Regular expressions.
//
// Apple documents the url-filter syntax as: ".*", ".", "\.", "[a-b]",
// "(abc)", "+", "*" and "?". That subset has no counted quantifier ({n},
// {n,}, {n,m}) and no alternation (a|b). Most regex rules in the pinned lists
// use a counted quantifier, so the build expands them: x{3} -> xxx,
// x{2,} -> xx+, x{1,3} -> xx?x?, which matches exactly the same strings.
// Anything else outside the subset makes the rule unsupported, and the build
// drops it and counts it. Two things beyond the documented table are
// accepted because every URL regex needs them and WebKit's parser takes
// them: a backslash before a non-alphanumeric character is that character
// (\/ \? \-), and "^" as the first or "$" as the last character anchors the
// match. Running the result through this function again changes nothing.

export class UnsupportedRegex extends Error {}

const ASCII = /^[\x20-\x7e]*$/;

export function safariRegex(source) {
  if (!ASCII.test(source)) throw new UnsupportedRegex("non-ASCII character");
  const atoms = []; // strings; "^"/"$" markers are not quantifiable
  const quantifiable = []; // parallel to atoms
  const groups = []; // start index in atoms of each open group
  const fail = (what) => {
    throw new UnsupportedRegex(what);
  };
  const last = () => {
    if (!atoms.length || !quantifiable[atoms.length - 1]) fail("quantifier without an atom");
    return atoms.length - 1;
  };
  const push = (atom, canQuantify = true) => {
    atoms.push(atom);
    quantifiable.push(canQuantify);
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "^") {
      if (i !== 0) fail('"^" not at the start');
      push("^", false);
    } else if (c === "$") {
      if (i !== source.length - 1) fail('"$" not at the end');
      push("$", false);
    } else if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) fail("trailing backslash");
      if (/[A-Za-z0-9]/.test(next)) fail(`escape \\${next}`);
      push(`\\${next}`);
      i++;
    } else if (c === "[") {
      if (source[i + 1] === "^") fail("negated character class");
      let j = i + 1;
      for (; j < source.length && source[j] !== "]"; j++) {
        if (source[j] === "\\") {
          if (/[A-Za-z0-9]/.test(source[j + 1] ?? "")) fail(`escape \\${source[j + 1]} in a character class`);
          j++;
        }
      }
      if (j >= source.length) fail("unterminated character class");
      if (j === i + 1) fail("empty character class");
      push(source.slice(i, j + 1));
      i = j;
    } else if (c === "(") {
      if (source[i + 1] === "?") fail("non-capturing group or assertion");
      groups.push(atoms.length);
      push("(", false);
    } else if (c === ")") {
      if (!groups.length) fail('unmatched ")"');
      const start = groups.pop();
      const inner = atoms.splice(start + 1).join("");
      quantifiable.splice(start + 1);
      atoms[start] = `(${inner})`;
      quantifiable[start] = true;
    } else if (c === "|") {
      fail("alternation");
    } else if (c === "?" || c === "*" || c === "+") {
      const index = last();
      if (source[i + 1] === "?") fail("lazy quantifier");
      atoms[index] += c;
      quantifiable[index] = false;
    } else if (c === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (!match) fail('"{" that is not a quantifier');
      const index = last();
      const atom = atoms[index];
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
      if (max < min) fail("quantifier with max below min");
      if (source[i + match[0].length] === "?") fail("lazy quantifier");
      let expanded;
      if (max === Infinity) expanded = min === 0 ? `${atom}*` : `${atom.repeat(min - 1)}${atom}+`;
      else expanded = `${atom.repeat(min)}${`${atom}?`.repeat(max - min)}`;
      atoms[index] = expanded;
      quantifiable[index] = false;
      i += match[0].length - 1;
    } else {
      push(c);
    }
  }
  if (groups.length) fail('unmatched "("');
  return atoms.join("");
}

// ---------------------------------------------------------------------------
// Rulesets.

// Returns { rule, changes } where rule is the Safari version of a Chrome rule
// or null when Safari cannot use it, and changes lists what was done and why.
export function safariRule(input) {
  const changes = [];
  const condition = {};
  for (const [key, value] of Object.entries(input.condition)) {
    const renamed = RENAMED_CONDITION_KEYS[key];
    if (renamed) {
      changes.push(`${key} renamed to ${renamed} (the name in Apple's Safari release notes)`);
      condition[renamed] = value;
    } else {
      condition[key] = value;
    }
  }
  const rule = { ...input, condition };

  for (const key of ["resourceTypes", "excludedResourceTypes"]) {
    const types = condition[key];
    if (!types) continue;
    const kept = types.filter((type) => SAFARI_RESOURCE_TYPES.has(type));
    const removed = types.filter((type) => !SAFARI_RESOURCE_TYPES.has(type));
    if (!removed.length) continue;
    if (kept.length) {
      condition[key] = kept;
      changes.push(`${key} without ${removed.join(", ")} (not resource types in Safari)`);
    } else if (key === "excludedResourceTypes") {
      // Excluding types Safari never sees excludes nothing.
      delete condition[key];
      changes.push(`${key} removed: ${removed.join(", ")} are not resource types in Safari`);
    } else {
      changes.push(`dropped: only matches ${removed.join(", ")}, not resource types in Safari`);
      return { rule: null, changes };
    }
  }

  if (rule.action.type === "allowAllRequests") {
    // "allowAllRequests (only for main_frame)".
    const types = condition.resourceTypes ?? [];
    if (!types.includes("main_frame")) {
      changes.push("dropped: allowAllRequests without main_frame (Safari allows it for main_frame only)");
      return { rule: null, changes };
    }
    if (types.length !== 1) {
      condition.resourceTypes = ["main_frame"];
      changes.push(`allowAllRequests limited to main_frame, without ${types.filter((t) => t !== "main_frame").join(", ")}`);
    }
  }

  if (condition.regexFilter) {
    try {
      const rewritten = safariRegex(condition.regexFilter);
      if (rewritten !== condition.regexFilter) {
        condition.regexFilter = rewritten;
        changes.push("regexFilter counted quantifiers expanded (not in Safari's documented regex syntax)");
      }
    } catch (error) {
      if (!(error instanceof UnsupportedRegex)) throw error;
      changes.push(`dropped: regexFilter uses ${error.message}, outside Safari's documented regex syntax`);
      return { rule: null, changes };
    }
  }
  return { rule, changes };
}

const EXAMPLES_PER_REASON = 3;

export function safariRuleset(rules) {
  const out = [];
  const byReason = new Map();
  const note = (reason, id) => {
    const entry = byReason.get(reason) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < EXAMPLES_PER_REASON) entry.examples.push(id);
    byReason.set(reason, entry);
  };
  let dropped = 0;
  let changed = 0;
  for (const input of rules) {
    const { rule, changes } = safariRule(input);
    for (const change of changes) note(change, input.id);
    if (!rule) dropped++;
    else {
      if (changes.length) changed++;
      out.push(rule);
    }
  }
  return {
    rules: out,
    stats: {
      rules: out.length,
      regexRules: out.filter((rule) => rule.condition.regexFilter).length,
      unchanged: out.length - changed,
      changed,
      dropped,
      changesByReason: Object.fromEntries(
        [...byReason.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Content blocker: element hiding without site access.
//
// A Safari content blocker is a separate extension whose rules Safari
// compiles and applies to every page by itself; it needs no site access and
// learns nothing about the user. Its css-display-none action is the CSS
// `display: none` that Chrome gets from content scripts. The mapping from
// the cosmetic step's output (scripts/cosmetic.mjs), in file order:
//
//   1 generic selectors      css-display-none, url-filter ".*" (every page),
//                            100 selectors per rule
//   2 generic selectors      css-display-none, url-filter ".*", unless-domain
//     with #@# or ~a.com     with exactly the excepting domains; selectors
//     exceptions             with the same domain set share a rule
//   3 $generichide and       one ignore-previous-rules rule, if-domain with
//     $elemhide exceptions   every excepted host: cancels rules 1 and 2 on
//                            those sites
//   4 site-specific          css-display-none, url-filter ".*", if-domain
//     selectors              with the filter's domains minus the ones that
//     (a.com,b.com##sel)     except it; one rule per distinct domain set,
//                            100 selectors per rule. After rule 3 because
//                            $generichide switches off generic hiding only
//   5 $elemhide exceptions   one ignore-previous-rules rule, if-domain with
//                            those hosts: $elemhide switches off all hiding.
//                            Absent when the lists have none
//
// "*a.com" in if-domain/unless-domain matches a.com and its subdomains.
// Apple's description of the fields is in "Creating a content blocker".
// Unlike Chrome's one shared file for excepted selectors, the exceptions are
// exact here, and unlike Chrome's content scripts the site-specific filters
// cost nothing: a content blocker rule with if-domain is exactly the
// condition "on these sites" that CSS cannot express.
//
// The ignore rules list only hosts. Four $generichide exceptions are path
// prefixes (`||bing.com/search?`); a domain condition cannot express a path,
// so the build widens them to the host: hiding is off on all of that site
// instead of its search pages. Nothing is hidden that a filter excepts.

// Turns a Chrome match pattern from cosmetic.mjs back into a host, and says
// whether a path was dropped.
export function hostOfPattern(pattern) {
  const match = /^\*:\/\/(\*\.)?([a-z0-9.-]+)\/(.*)$/.exec(pattern);
  if (!match) throw new Error(`not a host match pattern: ${pattern}`);
  const [, wildcard, host, rest] = match;
  return { host, subdomains: Boolean(wildcard), widened: rest !== "*" };
}

const domainCondition = ({ host, subdomains }) => (subdomains ? `*${host}` : host);
// cosmetic.mjs wrote "*://*.host/*" for domains and "*://host/*" for
// localhost and IP addresses; the excepted lists are bare domains.
const isBareHost = (domain) => domain === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(domain);

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function buildContentBlocker({ generic, excepted, specific = [], hidingExcludes, elemhideExcludes = [] }) {
  const rules = [];
  const hide = (selectors, trigger) => {
    for (const batch of chunks(selectors, SELECTORS_PER_RULE)) {
      rules.push({ trigger, action: { type: "css-display-none", selector: batch.join(",") } });
    }
  };
  const condition = (domain) => (isBareHost(domain) ? domain : `*${domain}`);
  // Selectors grouped by their exact domain list, one rule per group.
  const groupedRules = (entries, key) => {
    const groups = new Map();
    for (const { selector, domains } of entries) {
      const id = domains.join(" ");
      if (!groups.has(id)) groups.set(id, { domains, selectors: [] });
      groups.get(id).selectors.push(selector);
    }
    const before = rules.length;
    for (const { domains, selectors } of [...groups.values()].sort((a, b) => a.domains.join(" ").localeCompare(b.domains.join(" ")))) {
      hide(selectors, { "url-filter": ".*", [key]: domains.map(condition) });
    }
    return { groups: groups.size, rules: rules.length - before };
  };
  const hostsOf = (patterns, widened) => {
    const hosts = new Set();
    for (const pattern of patterns) {
      const parsed = hostOfPattern(pattern);
      if (parsed.widened && widened) widened.push({ pattern, host: parsed.host });
      hosts.add(domainCondition(parsed));
    }
    return [...hosts].sort();
  };
  const ignore = (hosts) => {
    if (hosts.length) rules.push({ trigger: { "url-filter": ".*", "if-domain": hosts }, action: { type: "ignore-previous-rules" } });
    return hosts.length ? 1 : 0;
  };

  // 1, 2
  hide(generic, { "url-filter": ".*" });
  const genericRules = rules.length;
  const exception = groupedRules(excepted, "unless-domain");
  // 3
  const widened = [];
  const hidingOff = hostsOf(hidingExcludes, widened);
  const genericIgnore = ignore(hidingOff);
  // 4
  const site = groupedRules(specific, "if-domain");
  // 5
  const elemhideOff = hostsOf(elemhideExcludes);
  const elemhideIgnore = ignore(elemhideOff);

  return {
    rules,
    stats: {
      rules: rules.length,
      selectors: generic.length + excepted.length + specific.length,
      genericSelectors: generic.length + excepted.length,
      genericRules,
      exceptionGroups: exception.groups,
      exceptionRules: exception.rules,
      specificSelectors: specific.length,
      specificGroups: site.groups,
      specificRules: site.rules,
      ignoreRules: genericIgnore + elemhideIgnore,
      hidingOffDomains: hidingOff.length,
      elemhideOffDomains: elemhideOff.length,
      pathPrefixExceptionsWidenedToHost: widened,
    },
  };
}

// ---------------------------------------------------------------------------
// Popup. The Chrome page is patched; every patch must match exactly once so
// that a change to src/popup.html is noticed here.

function replaceOnce(text, pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g")) ?? [];
  if (matches.length !== 1) throw new Error(`Safari popup patch "${what}": expected one match, found ${matches.length}`);
  return text.replace(pattern, replacement);
}

const SAFARI_OFF_NOTE = `  <p id="off-note" hidden>
    Requests from this site are no longer blocked. Element hiding still
    applies: it is the separate "add-block Hiding" content blocker, which
    Safari › Settings › Extensions can turn off for all sites.
  </p>`;

export function safariPopupHtml(html) {
  let out = replaceOnce(html, /\n[ \t]*<div class="row" id="count-row" hidden>[\s\S]*?<\/div>/, "", "remove the count row");
  out = replaceOnce(out, /[ \t]*<p id="off-note" hidden>[\s\S]*?<\/p>/, SAFARI_OFF_NOTE, "Safari wording for the off note");
  if (/chrome:/.test(out)) throw new Error("Safari popup still mentions a chrome: URL");
  return out;
}

export function safariPopupJs(js) {
  // The switch's per-request allow rule names the site as the initiator;
  // Safari's name for that condition is "domains" (see SAFARI_CONDITION_KEYS).
  const matches = js.match(/\binitiatorDomains\b/g) ?? [];
  if (matches.length !== 2) throw new Error(`Safari popup patch "domains": expected initiatorDomains twice in popup.js, found ${matches.length}`);
  return js.replace(/\binitiatorDomains\b/g, "domains");
}

// ---------------------------------------------------------------------------
// Writing dist-safari/.

export const SAFARI_DIST = "dist-safari";
export const SAFARI_EXTENSION_DIR = "extension";
export const CONTENT_BLOCKER_FILE = "content-blocker/blockerList.json";

function serializeRuleset(ruleset) {
  return "[\n" + ruleset.map((rule) => JSON.stringify(rule)).join(",\n") + "\n]\n";
}

// dist: the Chrome build directory; manifest: its manifest object (with
// content_scripts); rulesets: Map of resource id -> rules; cosmetic: the
// details from buildCosmetic. Returns the report section.
export async function buildSafari({ dist, manifest, rulesets, cosmetic }) {
  const extensionDir = path.join(SAFARI_DIST, SAFARI_EXTENSION_DIR);
  await rm(SAFARI_DIST, { recursive: true, force: true });
  await mkdir(extensionDir, { recursive: true });

  // Everything from dist/ except the stylesheets, the manifest and the
  // files written below.
  const { content_scripts: contentScripts, ...safariManifest } = manifest;
  await cp(dist, extensionDir, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(dist, source).split(path.sep).join("/");
      return !(rel === "css" || rel.startsWith("css/") || rel.startsWith("_metadata"));
    },
  });

  const report = { extensionDir, contentBlocker: CONTENT_BLOCKER_FILE, rulesets: [], manifest: {}, popup: {}, contentBlockerStats: {} };
  report.manifest.contentScriptsRemoved = contentScripts?.length ?? 0;
  report.manifest.why = "element hiding comes from the content blocker; without content scripts Safari asks for no site access";
  await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(safariManifest, null, 2) + "\n");

  for (const resource of safariManifest.declarative_net_request.rule_resources) {
    const { rules, stats } = safariRuleset(rulesets.get(resource.id));
    await writeFile(path.join(extensionDir, resource.path), serializeRuleset(rules));
    report.rulesets.push({ id: resource.id, chromeRules: rulesets.get(resource.id).length, ...stats });
  }

  const html = await readFile(path.join(dist, "popup.html"), "utf8");
  const js = await readFile(path.join(dist, "popup.js"), "utf8");
  await writeFile(path.join(extensionDir, "popup.html"), safariPopupHtml(html));
  await writeFile(path.join(extensionDir, "popup.js"), safariPopupJs(js));
  report.popup = {
    html: "count row removed; off note names the content blocker instead of the chrome:// site access link",
    js: "initiatorDomains renamed to domains in the switch rule",
  };

  const { rules, stats } = buildContentBlocker(cosmetic);
  const file = path.join(SAFARI_DIST, CONTENT_BLOCKER_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const json = serializeRuleset(rules);
  await writeFile(file, json);
  report.contentBlockerStats = { ...stats, bytes: Buffer.byteLength(json), specificFilters: cosmetic.specificStats };
  return report;
}
