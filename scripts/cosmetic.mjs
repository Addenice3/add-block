// Turns the generic cosmetic (element hiding) filters of the lists into
// static CSS plus the manifest `content_scripts` entries that apply it.
//
// Only CSS goes into pages. The filter dialect maps onto what a manifest can
// express without any code:
//   ##selector             -> css/generic/all.css, matched on every URL
//   ~a.com##selector       -> css/generic/excepted.css, which has
//   a.com#@#selector          exclude_matches for a.com (see below)
//   #@#selector            -> the selector is dropped everywhere
//   @@||a.com^$generichide -> a.com is added to exclude_matches of both files
//   @@||a.com^$elemhide       (a path prefix such as ||a.com/search? works too)
//
// Site-specific filters (a.com,b.com##selector) are not shipped as CSS. CSS
// cannot select on the page's host, so each distinct domain set would need
// its own content_scripts entry with its own match patterns: 5,400 entries
// for EasyList. Chrome's cost grows with the number of entries, and at that
// size installing the extension took 36 s and opening chrome://extensions
// 45 s in Chromium 153 (1,000 entries: 9 s). Making that work needs
// JavaScript in pages, which DESIGN.md rules out. They are counted in
// build-report.json, and handed to the Safari content blocker (details
// below), whose if-domain trigger is exactly that condition.
//
// Generic selectors with #@# exceptions all share one file that is excluded
// on the union of their excepting domains, instead of one file per distinct
// domain set (276 entries, each repeating the $generichide exclusions). On
// those domains (about 500) some generic selectors are therefore not
// applied; nothing is ever hidden that an exception says to leave alone.
//
// Everything else (#?# extended selectors, #$# snippets, uBO/AdGuard syntax,
// selectors the validator does not accept) is skipped and counted.
import { domainToASCII } from "node:url";

import { selectorProblem } from "./selector.mjs";

const SELECTORS_PER_RULE = 100;
const DECLARATION = "{display:none!important}";
const GENERIC_FILE = "css/generic/all.css";
const EXCEPTED_FILE = "css/generic/excepted.css";
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$|^localhost$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const EXAMPLES_PER_REASON = 3;

// "*." also matches the bare host. IP addresses and localhost have no
// subdomains.
function matchPattern(domain) {
  return domain === "localhost" || IPV4.test(domain) ? `*://${domain}/*` : `*://*.${domain}/*`;
}

function normalizeDomain(domain) {
  const ascii = domainToASCII(domain.toLowerCase());
  return DOMAIN.test(ascii) ? ascii : null;
}

// Splits the domains of a filter as parsed by adblockpluscore (a Map of
// domain -> included, with "" for the default) into include and exclude
// lists, dropping domains a match pattern cannot express (example.*).
function splitDomains(domains) {
  const include = [];
  const exclude = [];
  let dropped = 0;
  for (const [domain, included] of domains ?? []) {
    if (domain === "") continue;
    const normalized = normalizeDomain(domain);
    if (!normalized) dropped++;
    else (included ? include : exclude).push(normalized);
  }
  return { include, exclude, dropped };
}

// Parses "@@...$generichide" / "$elemhide" network exceptions into match
// patterns, or returns null when the pattern cannot be expressed as one.
function hidingExceptionPatterns(text, options) {
  const pattern = text.slice(2, text.lastIndexOf("$"));
  const domainOption = options.find((o) => o.startsWith("domain="));
  if (pattern === "" && domainOption) {
    const domains = domainOption.slice(7).split("|").map(normalizeDomain);
    return domains.every(Boolean) ? domains.map(matchPattern) : null;
  }
  if (domainOption || pattern.includes("*")) return null;
  let host;
  let rest;
  if (pattern.startsWith("||")) [host, rest] = pattern.slice(2).split(/(?=[/^])/, 2);
  else if (pattern.startsWith("://")) [host, rest] = pattern.slice(3).split(/(?=[/^:])/, 2);
  else return null;
  const domain = normalizeDomain(host);
  if (!domain) return null;
  if (rest === undefined || rest === "^") return [matchPattern(domain)];
  if (rest.startsWith("/") && !/[\^|]/.test(rest)) {
    return [`${pattern.startsWith("||") ? matchPattern(domain).slice(0, -2) : `*://${domain}`}${rest}*`];
  }
  return null;
}

function stylesheet(selectors) {
  const rules = [];
  for (let i = 0; i < selectors.length; i += SELECTORS_PER_RULE) {
    rules.push(`${selectors.slice(i, i + SELECTORS_PER_RULE).join(",\n")}\n${DECLARATION}\n`);
  }
  return rules.join("");
}

// filters: [{ line, filter }] where filter is an adblockpluscore Filter of
// type elemhide, elemhideexception, elemhideemulation, snippet or invalid,
// or an allowing filter with $generichide/$elemhide. Returns the CSS files,
// the content_scripts entries, the details the Safari build needs, and
// statistics.
export function buildCosmetic(filters) {
  const stats = { filters: 0, used: 0, skipped: 0, skippedByReason: new Map() };
  const skip = (reason, line) => {
    stats.skipped++;
    const entry = stats.skippedByReason.get(reason) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < EXAMPLES_PER_REASON) entry.examples.push(line);
    stats.skippedByReason.set(reason, entry);
  };

  const generic = []; // { line, selector, exclude: [domains] }
  const specific = []; // { line, selector, include: [domains], wildcardDropped }
  const exceptions = new Map(); // selector -> Set of domains ("" = everywhere)
  const hidingExcludes = new Set(); // match patterns from $generichide/$elemhide
  const elemhideExcludes = new Set(); // the $elemhide ones among them
  const specificDomains = new Set();
  let wildcardDomainsDropped = 0;

  for (const { line, filter } of filters) {
    stats.filters++;
    switch (filter.type) {
      case "elemhide": {
        const { include, exclude, dropped } = splitDomains(filter.domains);
        if (include.length || dropped) {
          // Not CSS (Chrome): see the file comment. The Safari content
          // blocker takes them (below, after the exceptions are known).
          include.forEach((domain) => specificDomains.add(domain));
          specific.push({ line, selector: filter.selector, include, exclude, wildcardDropped: dropped });
          skip("site-specific filter (Chrome: needs one content script per domain set, see DESIGN.md; Safari: in the content blocker)", line);
          break;
        }
        const problem = selectorProblem(filter.selector);
        if (problem) {
          skip(`selector not accepted by the validator: ${problem.replace(/ at offset \d+$/, "")}`, line);
          break;
        }
        generic.push({ line, selector: filter.selector, exclude });
        break;
      }
      case "elemhideexception": {
        const { include, dropped } = splitDomains(filter.domains);
        wildcardDomainsDropped += dropped;
        const set = exceptions.get(filter.selector) ?? new Set();
        if (!filter.domains) set.add("");
        for (const domain of include) set.add(domain);
        exceptions.set(filter.selector, set);
        stats.used++;
        break;
      }
      case "elemhideemulation":
        skip("extended selector (#?#, :-abp-has and the like) needs JavaScript", line);
        break;
      case "snippet":
        skip("snippet (#$#) needs JavaScript", line);
        break;
      case "allowing": {
        const options = line.slice(line.lastIndexOf("$") + 1).toLowerCase().split(",");
        const patterns = hidingExceptionPatterns(line, options);
        if (!patterns) {
          skip("$generichide/$elemhide exception whose pattern is not a host or path prefix", line);
          break;
        }
        patterns.forEach((pattern) => hidingExcludes.add(pattern));
        if (options.some((o) => o === "elemhide" || o === "ehide")) patterns.forEach((pattern) => elemhideExcludes.add(pattern));
        stats.used++;
        break;
      }
      default:
        skip("cosmetic syntax not understood by the parser", line);
    }
  }

  const all = [];
  const excepted = [];
  const exceptedDomains = new Set();
  for (const { line, selector, exclude } of generic) {
    const domains = exceptions.get(selector) ?? new Set();
    if (domains.has("")) {
      skip("removed by a generic #@# exception", line);
      continue;
    }
    stats.used++;
    if (exclude.length === 0 && domains.size === 0) {
      all.push(selector);
      continue;
    }
    const exceptedOn = [...new Set([...exclude, ...domains])].sort();
    excepted.push({ selector, domains: exceptedOn });
    for (const domain of exceptedOn) exceptedDomains.add(domain);
  }

  // Site-specific filters for the Safari content blocker: the selector on
  // its domains minus the domains (and their subdomains) that except it.
  // Counted apart from the CSS statistics above.
  const specificStats = { filters: specific.length, used: 0, skipped: 0, skippedByReason: new Map(), wildcardDomainsDropped: 0 };
  const skipSpecific = (reason, line) => {
    specificStats.skipped++;
    const entry = specificStats.skippedByReason.get(reason) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < EXAMPLES_PER_REASON) entry.examples.push(line);
    specificStats.skippedByReason.set(reason, entry);
  };
  const specificOut = [];
  const isOrUnder = (domain, parent) => domain === parent || domain.endsWith(`.${parent}`);
  for (const { line, selector, include, exclude, wildcardDropped } of specific) {
    specificStats.wildcardDomainsDropped += wildcardDropped;
    const excepting = exceptions.get(selector) ?? new Set();
    if (excepting.has("")) {
      skipSpecific("removed by a generic #@# exception", line);
      continue;
    }
    if (exclude.length) {
      skipSpecific("includes and excludes domains (a content blocker trigger has one domain condition)", line);
      continue;
    }
    if ([...excepting].some((e) => include.some((d) => isOrUnder(e, d) && e !== d))) {
      skipSpecific("excepted on a subdomain of an included domain (cannot be expressed)", line);
      continue;
    }
    const domains = include.filter((d) => ![...excepting].some((e) => isOrUnder(d, e))).sort();
    if (domains.length === 0) {
      skipSpecific(
        include.length === 0 ? "no domain a domain condition can express (example.* or a single label)" : "every domain excepted by #@#",
        line,
      );
      continue;
    }
    const problem = selectorProblem(selector);
    if (problem) {
      skipSpecific(`selector not accepted by the validator: ${problem.replace(/ at offset \d+$/, "")}`, line);
      continue;
    }
    specificStats.used++;
    specificOut.push({ selector, domains });
  }
  specificStats.skippedByReason = Object.fromEntries(
    [...specificStats.skippedByReason.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])),
  );

  const files = new Map();
  const contentScripts = [];
  const hiding = [...hidingExcludes];
  const entry = (file, selectors, excludes) => {
    if (selectors.length === 0) return;
    files.set(file, stylesheet(selectors));
    const excludeMatches = [...new Set(excludes)].sort();
    contentScripts.push({
      matches: ["<all_urls>"],
      ...(excludeMatches.length ? { exclude_matches: excludeMatches } : {}),
      css: [file],
      run_at: "document_start",
      all_frames: true,
    });
  };
  entry(GENERIC_FILE, all, hiding);
  entry(
    EXCEPTED_FILE,
    excepted.map(({ selector }) => selector),
    [...hiding, ...[...exceptedDomains].map(matchPattern)],
  );

  const cssBytes = [...files.values()].reduce((n, css) => n + Buffer.byteLength(css), 0);
  return {
    files,
    contentScripts,
    // What the Safari content blocker is built from (scripts/safari.mjs):
    // the generic selectors, the excepted ones with their exact domain sets,
    // the site-specific selectors with their domains, the $generichide and
    // $elemhide match patterns (all of them, and the $elemhide ones).
    details: { generic: all, excepted, specific: specificOut, specificStats, hidingExcludes: hiding, elemhideExcludes: [...elemhideExcludes] },
    stats: {
      filters: stats.filters,
      used: stats.used,
      skipped: stats.skipped,
      genericSelectors: all.length + excepted.length,
      genericSelectorsWithExceptions: excepted.length,
      exceptionDomains: exceptedDomains.size,
      hidingExceptionPatterns: hiding.length,
      wildcardExceptionDomainsDropped: wildcardDomainsDropped,
      specificFilterDomains: specificDomains.size,
      files: files.size,
      contentScripts: contentScripts.length,
      cssBytes,
      skippedByReason: Object.fromEntries(
        [...stats.skippedByReason.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])),
      ),
    },
  };
}
