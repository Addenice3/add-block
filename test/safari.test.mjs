// Checks the Safari build without a browser: the files are valid and laid
// out as documented, the counts fit Safari's limits, the transform does
// exactly what DESIGN.md says (and nothing to the Chrome output), and the
// Safari check rejects what it must. What only real Safari can tell is
// listed in DESIGN.md under "Safari".
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  CONTENT_BLOCKER_FILE,
  SAFARI_CONDITION_KEYS,
  SAFARI_EXTENSION_DIR,
  SAFARI_LIMITS,
  SAFARI_RESOURCE_TYPES,
  UnsupportedRegex,
  buildContentBlocker,
  hostOfPattern,
  safariPopupHtml,
  safariPopupJs,
  safariRegex,
  safariRule,
  safariRuleset,
} from "../scripts/safari.mjs";

const run = promisify(execFile);
const DIST = path.resolve("dist");
const ROOT = path.resolve("dist-safari");
const EXT = path.join(ROOT, SAFARI_EXTENSION_DIR);

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files.sort();
}
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

test("dist-safari/ is laid out as documented and every JSON file parses", async () => {
  const files = (await listFiles(ROOT)).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
  assert.ok(files.includes(CONTENT_BLOCKER_FILE), `has ${CONTENT_BLOCKER_FILE}`);
  for (const file of files.filter((f) => f.endsWith(".json"))) await json(path.join(ROOT, file));
  assert.deepEqual(
    files.filter((f) => f.endsWith(".css")),
    [],
    "no stylesheet anywhere: hiding is the content blocker",
  );

  // Same files as the Chrome build, minus css/.
  const chromeFiles = (await listFiles(DIST)).map((f) => path.relative(DIST, f).split(path.sep).join("/"));
  assert.deepEqual(
    files.filter((f) => f.startsWith(`${SAFARI_EXTENSION_DIR}/`)).map((f) => f.slice(SAFARI_EXTENSION_DIR.length + 1)),
    chromeFiles.filter((f) => !f.startsWith("css/") && !f.startsWith("_metadata/")),
  );

  const manifest = await json(path.join(EXT, "manifest.json"));
  const chromeManifest = await json(path.join(DIST, "manifest.json"));
  assert.equal(manifest.content_scripts, undefined, "no content scripts, so no site access");
  const { content_scripts: _, ...chromeRest } = chromeManifest;
  assert.deepEqual(manifest, chromeRest, "otherwise the Chrome manifest");

  const html = await readFile(path.join(EXT, "popup.html"), "utf8");
  assert.doesNotMatch(html, /count-row/, "no blocked count");
  assert.doesNotMatch(html, /chrome:/, "no chrome:// link");
  assert.match(html, /Settings › Extensions/, "Safari wording");
  const js = await readFile(path.join(EXT, "popup.js"), "utf8");
  assert.doesNotMatch(js, /initiatorDomains/);
  assert.match(js, /condition: \{ domains: \[site\] \}/, "the switch's allow rule uses Safari's condition name");
  assert.equal(js.replace(/\bdomains\b/g, "initiatorDomains"), await readFile(path.join(DIST, "popup.js"), "utf8"), "only that rename");
});

test("counts fit Safari's limits and match build-report.json", async () => {
  const manifest = await json(path.join(EXT, "manifest.json"));
  const report = (await json("build-report.json")).safari;
  const resources = manifest.declarative_net_request.rule_resources;
  assert.ok(resources.length <= SAFARI_LIMITS.MAX_NUMBER_OF_STATIC_RULESETS);
  assert.ok(resources.filter((r) => r.enabled).length <= SAFARI_LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS);
  for (const resource of resources) {
    const rules = await json(path.join(EXT, resource.path));
    const reported = report.rulesets.find((r) => r.id === resource.id);
    assert.equal(rules.length, reported.rules, `${resource.id}: rule count in the report`);
    assert.equal(rules.length, reported.chromeRules - reported.dropped);
    assert.equal(rules.filter((r) => r.condition.regexFilter).length, reported.regexRules);
    assert.ok(reported.regexRules <= SAFARI_LIMITS.MAX_NUMBER_OF_REGEX_RULES);
    const ids = new Set(rules.map((r) => r.id));
    assert.equal(ids.size, rules.length, "ids unique (gaps where rules were dropped are fine)");
  }
  const blocker = await json(path.join(ROOT, CONTENT_BLOCKER_FILE));
  const stats = report.contentBlockerStats;
  assert.equal(blocker.length, stats.rules);
  assert.ok(blocker.length <= SAFARI_LIMITS.CONTENT_BLOCKER_RULES);
  const cosmetic = (await json("build-report.json")).cosmetic;
  assert.equal(stats.genericSelectors, cosmetic.genericSelectors, "every generic selector the CSS has");
  assert.equal(stats.specificSelectors, stats.specificFilters.used, "every site-specific filter that was not skipped");
  assert.equal(stats.specificFilters.used + stats.specificFilters.skipped, stats.specificFilters.filters);
  assert.equal(stats.specificFilters.filters, cosmetic.skippedByReason[Object.keys(cosmetic.skippedByReason).find((k) => k.startsWith("site-specific"))].count);
  assert.equal(stats.selectors, stats.genericSelectors + stats.specificSelectors);
  // Order: generic hiding (no if-domain), the $generichide ignore rule, site-specific hiding (if-domain), nothing after.
  const kinds = blocker.map((r) => (r.action.type === "ignore-previous-rules" ? "I" : r.trigger["if-domain"] ? "S" : "G")).join("");
  assert.match(kinds, /^G+IS+$/, "generic rules, one ignore rule, site-specific rules (the lists have no $elemhide)");
  assert.equal(blocker.filter((r) => r.trigger["if-domain"] && r.action.type === "css-display-none").length, stats.specificRules);
  console.log(
    `Safari: ${report.rulesets.map((r) => `${r.id} ${r.rules} rules`).join(", ")}; content blocker ${blocker.length} rules, ` +
      `${stats.selectors} selectors (${stats.specificSelectors} site-specific), ${stats.bytes} bytes`,
  );
});

test("safariRule changes exactly what Apple documents, and nothing else", () => {
  const block = (condition, extra = {}) => ({ id: 1, priority: 1000, condition, action: { type: "block" }, ...extra });

  // Resource types Safari does not have are removed; a rule left with none is dropped.
  let result = safariRule(block({ urlFilter: "/ad.", resourceTypes: ["csp_report", "script", "object", "webbundle"] }));
  assert.deepEqual(result.rule.condition, { urlFilter: "/ad.", resourceTypes: ["script"] });
  assert.equal(result.changes.length, 1);
  assert.match(result.changes[0], /csp_report, object, webbundle/);
  result = safariRule(block({ urlFilter: "/ad.", resourceTypes: ["object"] }));
  assert.equal(result.rule, null);
  assert.match(result.changes[0], /^dropped: only matches object/);
  result = safariRule(block({ urlFilter: "/ad.", excludedResourceTypes: ["webbundle"] }));
  assert.deepEqual(result.rule.condition, { urlFilter: "/ad." }, "excluding a type Safari never sees excludes nothing");
  result = safariRule(block({ urlFilter: "/ad.", excludedResourceTypes: ["webbundle", "image"] }));
  assert.deepEqual(result.rule.condition, { urlFilter: "/ad.", excludedResourceTypes: ["image"] });

  // allowAllRequests only for main_frame.
  const allowAll = (types) => ({ id: 1000001, priority: 2010, condition: { urlFilter: "||a.com^", resourceTypes: types }, action: { type: "allowAllRequests" } });
  result = safariRule(allowAll(["main_frame", "sub_frame"]));
  assert.deepEqual(result.rule.condition.resourceTypes, ["main_frame"]);
  assert.match(result.changes[0], /limited to main_frame, without sub_frame/);
  result = safariRule(allowAll(["sub_frame"]));
  assert.equal(result.rule, null);

  // Chrome's initiator names become Safari's, in place.
  result = safariRule(block({ urlFilter: "||b.com^", resourceTypes: ["script"], initiatorDomains: ["a.com"], excludedInitiatorDomains: ["x.a.com"] }));
  assert.deepEqual(Object.keys(result.rule.condition), ["urlFilter", "resourceTypes", "domains", "excludedDomains"], "key order kept");
  assert.deepEqual(result.rule.condition.domains, ["a.com"]);
  assert.deepEqual(result.rule.condition.excludedDomains, ["x.a.com"]);
  assert.equal(result.changes.length, 2);
  for (const key of Object.keys(result.rule.condition)) assert.ok(SAFARI_CONDITION_KEYS.has(key), key);

  // A rule Safari takes as it is comes back equal, and the input is never touched.
  const input = block({ urlFilter: "||c.com^", domainType: "thirdParty", resourceTypes: [...SAFARI_RESOURCE_TYPES], requestDomains: ["c.com"] });
  const copy = JSON.parse(JSON.stringify(input));
  result = safariRule(input);
  assert.deepEqual(result, { rule: copy, changes: [] });
  assert.deepEqual(input, copy);
  safariRule(block({ urlFilter: "/ad.", resourceTypes: ["csp_report", "script"], initiatorDomains: ["a.com"] }));
  assert.deepEqual(input, copy);

  // Regex: expanded or dropped, counted by reason.
  result = safariRule(block({ regexFilter: "a{2}" }));
  assert.equal(result.rule.condition.regexFilter, "aa");
  result = safariRule(block({ regexFilter: "a|b" }));
  assert.equal(result.rule, null);
  assert.match(result.changes[0], /alternation/);

  const { rules, stats } = safariRuleset([
    block({ urlFilter: "/x", resourceTypes: ["object"] }),
    block({ urlFilter: "/y", resourceTypes: ["csp_report", "image"] }, { id: 2 }),
    block({ urlFilter: "/z" }, { id: 3 }),
  ]);
  assert.deepEqual(rules.map((r) => r.id), [2, 3]);
  assert.deepEqual({ rules: stats.rules, changed: stats.changed, dropped: stats.dropped, unchanged: stats.unchanged }, { rules: 2, changed: 1, dropped: 1, unchanged: 1 });
  assert.deepEqual(Object.values(stats.changesByReason).map((r) => r.count), [1, 1]);
});

// Strings over the regex's own characters plus noise, to compare the
// original and the rewritten regex on.
function sampleStrings(regex, count = 400) {
  const alphabet = [...new Set(`${regex.replace(/[\\^$.*+?()[\]{}|]/g, "")}/.?ajz09-:`)];
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const strings = [];
  for (let i = 0; i < count; i++) {
    const length = Math.floor(random() * 60);
    let s = "";
    for (let j = 0; j < length; j++) s += alphabet[Math.floor(random() * alphabet.length)];
    strings.push(s);
  }
  return strings;
}

test("safariRegex: counted quantifiers expand to the same language, the rest of the documented subset passes through, anything else is refused", async () => {
  const cases = {
    "a{3}": "aaa",
    "a{2,}": "aa+",
    "a{0,}": "a*",
    "a{1,}": "a+",
    "a{1,3}": "aa?a?",
    "a{0,2}": "a?a?",
    "[0-9a-f]{2}x": "[0-9a-f][0-9a-f]x",
    "(ab){2,3}c": "(ab)(ab)(ab)?c",
    "^https?:\\/\\/www\\.[0-9a-z]{2,}\\.com\\/[0-9a-z]{1,2}\\.js$": "^https?:\\/\\/www\\.[0-9a-z][0-9a-z]+\\.com\\/[0-9a-z][0-9a-z]?\\.js$",
    "\\/content\\/{3,}": "\\/content\\/\\/\\/+",
    ".*sw[0-9._].*": ".*sw[0-9._].*",
    "a\\-b\\?c": "a\\-b\\?c",
  };
  for (const [source, expected] of Object.entries(cases)) {
    const out = safariRegex(source);
    assert.equal(out, expected, source);
    assert.equal(safariRegex(out), out, `idempotent: ${source}`);
    const before = new RegExp(source);
    const after = new RegExp(out);
    for (const s of [...sampleStrings(source), "aaa", "aa", "a", "", "aaaa", "abababc", "ab/content////x"]) {
      assert.equal(after.test(s), before.test(s), `${source} vs ${out} on ${JSON.stringify(s)}`);
    }
  }
  for (const [source, reason] of [
    ["a|b", /alternation/],
    ["(td|tdbank)", /alternation/],
    ["\\d+", /escape \\d/],
    ["[^a]", /negated/],
    ["[\\d]", /escape \\d in a character class/],
    ["a*?", /lazy/],
    ["a{2,3}?", /lazy/],
    ["a^b", /not at the start/],
    ["a$b", /not at the end/],
    ["(?:a)", /non-capturing/],
    ["(?=a)", /non-capturing/],
    ["a{3,2}", /max below min/],
    ["a{", /not a quantifier/],
    ["{2}", /without an atom/],
    ["^{2}", /without an atom/],
    ["a**", /without an atom/],
    ["(a", /unmatched/],
    ["a)", /unmatched/],
    ["[a", /unterminated/],
    ["[]", /empty/],
    ["é", /non-ASCII/],
    ["a\\", /trailing/],
  ]) {
    assert.throws(() => safariRegex(source), (e) => e instanceof UnsupportedRegex && reason.test(e.message), `${source} should be refused with ${reason}`);
  }

  // The built rulesets: every Chrome regex passed through or expanded (and
  // still means the same) or was refused for alternation; every Safari
  // regex is final.
  const chromeManifest = await json(path.join(DIST, "manifest.json"));
  let expanded = 0;
  let unchanged = 0;
  let refused = 0;
  for (const resource of chromeManifest.declarative_net_request.rule_resources) {
    for (const rule of await json(path.join(DIST, resource.path))) {
      const source = rule.condition.regexFilter;
      if (!source) continue;
      try {
        const out = safariRegex(source);
        if (out === source) unchanged++;
        else expanded++;
        const before = new RegExp(source);
        const after = new RegExp(out);
        for (const s of sampleStrings(source)) assert.equal(after.test(s), before.test(s), `${source} on ${JSON.stringify(s)}`);
      } catch (error) {
        if (!(error instanceof UnsupportedRegex)) throw error;
        refused++;
        assert.match(error.message, /alternation/);
      }
    }
    for (const rule of await json(path.join(EXT, resource.path))) {
      if (rule.condition.regexFilter) assert.equal(safariRegex(rule.condition.regexFilter), rule.condition.regexFilter);
    }
  }
  console.log(`Chrome regex rules: ${expanded} expanded for Safari, ${unchanged} unchanged, ${refused} refused (alternation)`);
  assert.ok(expanded > 0 && refused > 0, "the pinned lists exercise both paths");
});

test("buildContentBlocker: generic rules, exact exception groups, the $generichide ignore rule, site-specific rules, the $elemhide ignore rule", () => {
  const generic = Array.from({ length: 250 }, (_, i) => `.g${i}`);
  const excepted = [
    { selector: ".a", domains: ["a.com", "b.com"] },
    { selector: ".b", domains: ["a.com", "b.com"] },
    { selector: ".c", domains: ["localhost"] },
  ];
  const hidingExcludes = ["*://*.x.com/*", "*://*.bing.com/search?*", "*://*.bing.com/*", "*://localhost/*", "*://10.0.0.1/*"];
  const specific = [
    { selector: "#s1", domains: ["s.com"] },
    { selector: "#s2", domains: ["s.com"] },
    { selector: "#s3", domains: ["s.com", "t.org"] },
  ];
  const elemhideExcludes = ["*://*.x.com/*"];
  const { rules, stats } = buildContentBlocker({ generic, excepted, specific, hidingExcludes, elemhideExcludes });
  assert.equal(rules.length, 3 + 2 + 1 + 2 + 1);
  assert.deepEqual(rules[0].trigger, { "url-filter": ".*" });
  assert.equal(rules[0].action.selector.split(",").length, 100);
  assert.equal(rules[2].action.selector.split(",").length, 50);
  assert.deepEqual(rules[3], {
    trigger: { "url-filter": ".*", "unless-domain": ["*a.com", "*b.com"] },
    action: { type: "css-display-none", selector: ".a,.b" },
  });
  assert.deepEqual(rules[4].trigger, { "url-filter": ".*", "unless-domain": ["localhost"] });
  assert.deepEqual(rules[5], {
    trigger: { "url-filter": ".*", "if-domain": ["*bing.com", "*x.com", "10.0.0.1", "localhost"] },
    action: { type: "ignore-previous-rules" },
  });
  assert.deepEqual(rules[6], {
    trigger: { "url-filter": ".*", "if-domain": ["*s.com"] },
    action: { type: "css-display-none", selector: "#s1,#s2" },
  });
  assert.deepEqual(rules[7].trigger, { "url-filter": ".*", "if-domain": ["*s.com", "*t.org"] });
  assert.deepEqual(rules[8], { trigger: { "url-filter": ".*", "if-domain": ["*x.com"] }, action: { type: "ignore-previous-rules" } });
  assert.deepEqual(stats.pathPrefixExceptionsWidenedToHost, [{ pattern: "*://*.bing.com/search?*", host: "bing.com" }]);
  assert.deepEqual({ ...stats, pathPrefixExceptionsWidenedToHost: undefined }, {
    rules: 9, selectors: 256, genericSelectors: 253, genericRules: 3, exceptionGroups: 2, exceptionRules: 2,
    specificSelectors: 3, specificGroups: 2, specificRules: 2, ignoreRules: 2, hidingOffDomains: 4, elemhideOffDomains: 1,
    pathPrefixExceptionsWidenedToHost: undefined,
  });
  // Without site-specific filters and $elemhide: the ignore rule is last.
  const plain = buildContentBlocker({ generic: [".g"], excepted: [], hidingExcludes: ["*://*.x.com/*"] });
  assert.deepEqual(plain.rules.map((r) => r.action.type), ["css-display-none", "ignore-previous-rules"]);
  assert.deepEqual(hostOfPattern("*://*.a.com/path*"), { host: "a.com", subdomains: true, widened: true });
  assert.throws(() => hostOfPattern("<all_urls>"));

  // The built file follows the same order: hiding rules, then the one ignore rule.
});

test("popup patches apply exactly once and fail loudly when the source moves", async () => {
  const html = await readFile(path.join("src", "popup.html"), "utf8");
  const patched = safariPopupHtml(html);
  assert.doesNotMatch(patched, /count-row|chrome:/);
  assert.match(patched, /id="off-note"/);
  assert.throws(() => safariPopupHtml(html.replace('id="count-row"', 'id="count-row2"')), /remove the count row/);
  assert.throws(() => safariPopupHtml(html.replace('<p id="off-note" hidden>', "<p>")), /off note/);
  const js = await readFile(path.join("src", "popup.js"), "utf8");
  assert.equal((safariPopupJs(js).match(/\bdomains\b/g) ?? []).length, 2);
  assert.throws(() => safariPopupJs(js + "\ninitiatorDomains\n"), /expected initiatorDomains twice/);
});

test("the Chrome output is not changed by the Safari build", async () => {
  const manifest = await json(path.join(DIST, "manifest.json"));
  assert.ok(manifest.content_scripts?.length, "Chrome keeps its content scripts");
  let chromeOnly = { csp_report: 0, initiatorDomains: 0, subFrameAllowAll: 0, countedQuantifier: 0 };
  for (const resource of manifest.declarative_net_request.rule_resources) {
    for (const rule of await json(path.join(DIST, resource.path))) {
      if (rule.condition.resourceTypes?.includes("csp_report")) chromeOnly.csp_report++;
      if (rule.condition.initiatorDomains) chromeOnly.initiatorDomains++;
      if (rule.action.type === "allowAllRequests" && rule.condition.resourceTypes?.includes("sub_frame")) chromeOnly.subFrameAllowAll++;
      if (/\{\d/.test(rule.condition.regexFilter ?? "")) chromeOnly.countedQuantifier++;
    }
  }
  for (const [what, n] of Object.entries(chromeOnly)) assert.ok(n > 0, `Chrome rulesets still carry ${what}`);

  // Against the base branch, when the checkout has it: rulesets and CSS are
  // byte-identical (only manifest.json and the popup changed in this version).
  for (const ref of ["origin/main", "main"]) {
    try {
      await run("git", ["rev-parse", "--verify", "--quiet", ref]);
    } catch {
      continue;
    }
    await run("git", ["diff", "--quiet", ref, "--", "dist/rulesets", "dist/css", "lists.lock.json"]).catch((error) => {
      assert.fail(`dist/rulesets or dist/css differ from ${ref}: ${error.stdout}${error.stderr}`);
    });
    console.log(`dist/rulesets and dist/css are byte-identical to ${ref}`);
    return;
  }
  console.log("no main branch to compare dist/ against; skipped");
});

async function expectSafariCheckFailure(name, mutate, expected) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "add-block-safari-bad-"));
  try {
    await cp(ROOT, dir, { recursive: true });
    const ext = path.join(dir, SAFARI_EXTENSION_DIR);
    const manifestPath = path.join(ext, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const blockerPath = path.join(dir, CONTENT_BLOCKER_FILE);
    const blocker = JSON.parse(await readFile(blockerPath, "utf8"));
    await mutate({ dir, ext, manifest, blocker });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(blockerPath, JSON.stringify(blocker));
    await assert.rejects(run(process.execPath, ["scripts/check.mjs", "--safari", dir]), (error) => {
      assert.equal(error.code, 1, `${name}: check should exit 1`);
      for (const pattern of expected) assert.match(error.stderr, pattern, `${name}: expected ${pattern}`);
      return true;
    });
    console.log(`check --safari rejects ${name}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("npm run check covers the Safari build: passes on dist-safari/, rejects site access, Chrome-only rule syntax and unsafe content blocker rules", async () => {
  const { stdout } = await run(process.execPath, ["scripts/check.mjs", "--safari"]);
  assert.match(stdout, /^OK: .*no content scripts/m);

  const editRules = async (ext, manifest, edit) => {
    const file = path.join(ext, manifest.declarative_net_request.rule_resources[0].path);
    const rules = JSON.parse(await readFile(file, "utf8"));
    edit(rules);
    await writeFile(file, JSON.stringify(rules));
  };
  await expectSafariCheckFailure(
    "a content script (site access)",
    async ({ ext, manifest }) => {
      manifest.content_scripts = [{ matches: ["<all_urls>"], css: ["hide.css"] }];
      await writeFile(path.join(ext, "hide.css"), "x{display:none!important}\n");
    },
    [/manifest key not allowed: content_scripts/, /no content scripts allowed in the Safari build/, /unexpected file type: hide.css/],
  );
  await expectSafariCheckFailure(
    "a chrome:// URL in the popup",
    async ({ ext }) => {
      const file = path.join(ext, "popup.html");
      await writeFile(file, (await readFile(file, "utf8")).replace("</body>", '<a href="chrome://extensions/?id=">x</a></body>'));
    },
    [/popup.html: URL in page: chrome:\/\/extensions/],
  );
  await expectSafariCheckFailure(
    "the blocked count row",
    async ({ ext }) => {
      const file = path.join(ext, "popup.html");
      await writeFile(file, (await readFile(file, "utf8")).replace("</body>", '<div id="count-row"></div></body>'));
    },
    [/must not show the blocked count/],
  );
  await expectSafariCheckFailure(
    "initiatorDomains in the popup script",
    async ({ ext }) => {
      const file = path.join(ext, "popup.js");
      await writeFile(file, (await readFile(file, "utf8")) + "\n// initiatorDomains\n");
    },
    [/popup.js: initiatorDomains is not a condition name Safari documents/],
  );
  await expectSafariCheckFailure(
    "a Chrome-only resource type",
    ({ ext, manifest }) => editRules(ext, manifest, (rules) => (rules[0].condition.resourceTypes = ["script", "csp_report"])),
    [/resourceTypes has csp_report, not a resource type in Safari/],
  );
  await expectSafariCheckFailure(
    "initiatorDomains in a rule",
    ({ ext, manifest }) => editRules(ext, manifest, (rules) => (rules[0].condition.initiatorDomains = ["a.com"])),
    [/uses condition initiatorDomains, which Safari does not document/],
  );
  await expectSafariCheckFailure(
    "allowAllRequests for sub_frame",
    ({ ext, manifest }) =>
      editRules(ext, manifest, (rules) => {
        const rule = rules.find((r) => r.action.type === "allowAllRequests");
        rule.condition.resourceTypes = ["main_frame", "sub_frame"];
      }),
    [/allowAllRequests must be for main_frame only/],
  );
  await expectSafariCheckFailure(
    "a regex outside Safari's syntax",
    ({ ext, manifest }) =>
      editRules(ext, manifest, (rules) => {
        rules[0].condition = { regexFilter: "a{2}" };
        rules[1].condition = { regexFilter: "a|b" };
      }),
    [/regexFilter is not in Safari's regex syntax as written/, /regexFilter uses alternation/],
  );
  await expectSafariCheckFailure(
    "a content blocker rule that blocks requests",
    ({ blocker }) => blocker.push({ trigger: { "url-filter": "ads" }, action: { type: "block" } }),
    [/action not allowed: block/, /url-filter must be "\.\*"/],
  );
  await expectSafariCheckFailure(
    "a selector with url()",
    ({ blocker }) => (blocker[0].action.selector = "div[style*=\"url(x)\"]"),
    [/rule 0: selector contains \{, \}, \/\* or url\(/],
  );
  await expectSafariCheckFailure(
    "a selector the validator does not accept",
    ({ blocker }) => (blocker[0].action.selector = ".a:has-text(x)"),
    [/unsupported functional pseudo-class :has-text/],
  );
  await expectSafariCheckFailure(
    "a generic hiding rule after the $generichide ignore rule, and a site-specific one before it",
    ({ blocker }) => {
      blocker.push({ trigger: { "url-filter": ".*" }, action: { type: "css-display-none", selector: ".x" } });
      blocker.unshift({ trigger: { "url-filter": ".*", "if-domain": ["*a.com"] }, action: { type: "css-display-none", selector: ".y" } });
    },
    [/generic hiding rule after the \$generichide ignore rule/, /site-specific hiding rule before the \$generichide ignore rule/],
  );
  await expectSafariCheckFailure(
    "a third ignore rule and a hiding rule after the last one",
    ({ blocker }) =>
      blocker.push(
        { trigger: { "url-filter": ".*", "if-domain": ["*a.com"] }, action: { type: "ignore-previous-rules" } },
        { trigger: { "url-filter": ".*", "if-domain": ["*a.com"] }, action: { type: "css-display-none", selector: ".z" } },
        { trigger: { "url-filter": ".*", "if-domain": ["*a.com"] }, action: { type: "ignore-previous-rules" } },
      ),
    [/hiding rule after the last ignore rule/, /more than two ignore-previous-rules rules/],
  );
  await expectSafariCheckFailure(
    "an unlimited ignore rule and an odd domain",
    ({ blocker }) => {
      blocker.find((r) => r.action.type === "ignore-previous-rules").trigger = { "url-filter": ".*", "unless-domain": ["Bad.Com/"] };
    },
    [/ignore-previous-rules must be limited by if-domain/, /bad domain in unless-domain: Bad.Com\//],
  );
});
