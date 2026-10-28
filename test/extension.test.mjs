// Loads dist/ into Chromium and checks that it blocks known ad and tracker
// requests, hides elements that cosmetic filters name, and leaves everything
// else alone. All traffic goes to a local HTTP proxy, so the test never
// touches the real network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { chromium } from "playwright";

import { expandMergedRules } from "../scripts/merge.mjs";

const DIST = path.resolve("dist");
const PAGE = "http://news.site.test/";
const BLOCKED_BY_CLIENT = "net::ERR_BLOCKED_BY_CLIENT";
const DECLARATION = "{display:none!important}";

// Hosts on Chromium's HSTS preload list (google-analytics.com, for one) are
// upgraded to HTTPS before reaching the proxy, so they cannot be used here.
const RESOURCES = [
  {
    name: "EasyList host rule ||g.doubleclick.net^ (subdomain)",
    url: "http://securepubads.g.doubleclick.net/tag/js/gpt.js",
    tag: "script",
    blocked: true,
  },
  {
    name: "EasyList path rule /pagead/conversion.js$script",
    url: "http://cdn.site.test/pagead/conversion.js",
    tag: "script",
    blocked: true,
  },
  {
    name: "EasyPrivacy host rule ||googletagmanager.com^",
    url: "http://www.googletagmanager.com/gtm.js?id=GTM-TEST",
    tag: "script",
    blocked: true,
  },
  {
    name: "EasyPrivacy rule ||scorecardresearch.com^$third-party",
    url: "http://sb.scorecardresearch.com/beacon.js",
    tag: "script",
    blocked: true,
  },
  { name: "control script", url: "http://cdn.site.test/app.js", tag: "script", blocked: false },
  { name: "control image", url: "http://cdn.site.test/logo.png", tag: "img", blocked: false },
];

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function pageHtml() {
  const tags = RESOURCES.map(({ url, tag }) =>
    tag === "img" ? `<img src="${url}" alt="">` : `<script src="${url}"></script>`,
  );
  return `<!doctype html><title>test</title>${tags.join("\n")}`;
}

// The element-hiding page: one element per selector under test, plus a
// control. The page's own stylesheet tries to show everything with
// !important, so the test also proves that the extension's CSS wins over
// the page's own.
const SIMPLE_SELECTOR = /^[#.][A-Za-z_][\w-]*$/;
function elementHtml(selectors) {
  const elements = selectors.map(({ name, selector }) => {
    const attribute = selector.startsWith("#") ? `id="${selector.slice(1)}"` : `class="${selector.slice(1)}"`;
    return `<div data-test="${name}" ${attribute}>${name}</div>`;
  });
  return (
    `<!doctype html><title>elements</title><style>div{display:block!important}</style>` +
    `${elements.join("\n")}\n<div data-test="control" id="content" class="article">control</div>`
  );
}

let proxy;
let proxyUrl;
const seen = new Set();
let elementPage = "";

before(async () => {
  proxy = http.createServer((req, res) => {
    // A proxy receives absolute URLs.
    seen.add(req.url);
    const url = new URL(req.url);
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(pageHtml());
    } else if (url.pathname === "/elements.html") {
      res.writeHead(200, { "content-type": "text/html" }).end(elementPage);
    } else if (url.pathname.endsWith(".png")) {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    } else if (url.pathname.endsWith(".js")) {
      res.writeHead(200, { "content-type": "text/javascript" }).end("// ok\n");
    } else {
      res.writeHead(404).end();
    }
  });
  // Refuse HTTPS tunnels (browser background traffic): nothing leaves the machine.
  proxy.on("connect", (req, socket) => {
    // The browser may reset the socket before the refusal is read.
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => new Promise((resolve) => proxy.close(resolve)));

async function launch(extensionDir, profileDir = null) {
  // A caller that passes profileDir keeps it (to restart the browser with
  // the same profile) and removes it itself.
  const userDataDir = profileDir ?? (await mkdtemp(path.join(os.tmpdir(), "add-block-profile-")));
  const args = extensionDir ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] : [];
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The full Chromium build is needed for extensions; the headless shell has none.
    channel: "chromium",
    headless: true,
    proxy: { server: proxyUrl },
    args,
  });
  return {
    context,
    close: async () => {
      await context.close();
      if (!profileDir) await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

// Returns { url: "ok" | errorText } for every resource on the test page.
async function loadPage(context) {
  const page = await context.newPage();
  const outcomes = {};
  page.on("requestfinished", (request) => (outcomes[request.url()] ??= "ok"));
  page.on("requestfailed", (request) => (outcomes[request.url()] = request.failure()?.errorText));
  await page.goto(PAGE, { waitUntil: "load" });
  await page.close();
  return outcomes;
}

async function extensionsInfo(context) {
  const page = await context.newPage();
  await page.goto("chrome://extensions");
  const info = await page.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve),
      ),
  );
  await page.close();
  return info;
}

// A copy of dist/ with an empty service worker (and, optionally, extra
// permissions) only so a test can call the declarativeNetRequest API.
// dist/ itself has no background script.
async function makeProbe(permissions = [], rulesetTransform = null) {
  const probeDir = await mkdtemp(path.join(os.tmpdir(), "add-block-probe-"));
  await cp(DIST, probeDir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(probeDir, "manifest.json"), "utf8"));
  manifest.background = { service_worker: "probe.js" };
  manifest.permissions.push(...permissions);
  for (const resource of manifest.declarative_net_request.rule_resources) {
    if (!rulesetTransform) continue;
    const file = path.join(probeDir, resource.path);
    const rules = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(rulesetTransform(rules)));
  }
  await writeFile(path.join(probeDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(probeDir, "probe.js"), "");
  return { probeDir, manifest, remove: () => rm(probeDir, { recursive: true, force: true }) };
}

// Opens the popup page in its own unfocused window, so that the popup's
// own "active tab in the last focused window" query finds the web page, as
// it does under the toolbar button. Needs a worker in the probe.
async function openPopup(context, worker) {
  const popupPromise = context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/popup.html") });
  await worker.evaluate(() =>
    chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), type: "popup", focused: false, width: 320, height: 420 }),
  );
  const popup = await popupPromise;
  await popup.waitForFunction(() => document.getElementById("site").textContent !== "…");
  return popup;
}

async function popupState(popup) {
  return popup.evaluate(() => ({
    site: document.getElementById("site").textContent,
    label: document.getElementById("site-label").textContent,
    on: document.getElementById("switch").checked,
    disabled: document.getElementById("switch").disabled,
    count: document.getElementById("count-row").hidden ? null : document.getElementById("count").textContent,
    countTitle: document.getElementById("count").title,
    note: document.getElementById("note").textContent,
    offNote: !document.getElementById("off-note").hidden,
  }));
}

const BLOCKED_COUNT = RESOURCES.filter((r) => r.blocked).length;

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test("without the extension every request goes through (harness check)", async () => {
  const { context, close } = await launch(null);
  try {
    seen.clear();
    const outcomes = await loadPage(context);
    for (const { name, url } of RESOURCES) {
      assert.equal(outcomes[url], "ok", `${name}: ${url}`);
      assert.ok(seen.has(url), `${name}: proxy should see ${url}`);
    }
  } finally {
    await close();
  }
});

test("dist/ loads cleanly, asks for the documented permissions and blocks ads and trackers", async () => {
  const { context, close } = await launch(DIST);
  try {
    const extensions = await extensionsInfo(context);
    assert.equal(extensions.length, 1, "exactly one extension loaded");
    const [extension] = extensions;
    assert.equal(extension.name, "add-block");
    assert.equal(extension.state, "ENABLED");
    assert.deepEqual(extension.manifestErrors, [], "no manifest errors");
    assert.deepEqual(extension.installWarnings, [], "no install warnings (e.g. ignored rules)");
    assert.deepEqual(extension.runtimeErrors, [], "no runtime errors");

    // What Chrome tells the user. The <all_urls> content scripts show up as
    // site access ("On all sites", which the user can restrict), not as a
    // permission message.
    const { simplePermissions, runtimeHostPermissions } = extension.permissions;
    const messages = simplePermissions.map((p) => p.message);
    console.log(
      `Chromium ${context.browser()?.version()} permission messages: ${JSON.stringify(messages)}; ` +
        `site access: ${runtimeHostPermissions.hostAccess}`,
    );
    assert.deepEqual(messages, ["Block content on any page"], "only the declarativeNetRequest message; activeTab adds none");
    assert.equal(runtimeHostPermissions.hostAccess, "ON_ALL_SITES", "content scripts match <all_urls>");
    assert.deepEqual(extension.permissions.simplePermissions.length, 1);

    // Rulesets are indexed when the extension loads; allow a moment for that.
    let outcomes;
    for (let attempt = 1; attempt <= 5; attempt++) {
      seen.clear();
      outcomes = await loadPage(context);
      if (RESOURCES.every(({ url, blocked }) => (outcomes[url] === BLOCKED_BY_CLIENT) === blocked)) {
        if (attempt > 1) console.log(`Blocking took effect on page load ${attempt}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    for (const { name, url, blocked } of RESOURCES) {
      if (blocked) {
        assert.equal(outcomes[url], BLOCKED_BY_CLIENT, `${name} should be blocked: ${url}`);
        assert.ok(!seen.has(url), `${name}: blocked request must not reach the network`);
      } else {
        assert.equal(outcomes[url], "ok", `${name} should load: ${url}`);
      }
    }
  } finally {
    await close();
  }
});

// Picks test cases from the built stylesheets, so the test follows list
// updates: the first simple #id/.class selector of each generic stylesheet,
// and domains that the manifest excludes from them.
async function pickCases() {
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8"));
  const entry = (file) => manifest.content_scripts.find((e) => e.css[0] === file);
  const firstSimple = async (file) =>
    (await readFile(path.join(DIST, file), "utf8"))
      .split("\n")
      .map((line) => line.replace(/,$/, ""))
      .find((line) => SIMPLE_SELECTOR.test(line));
  // Some domains are HSTS-preloaded in Chromium and never reach the HTTP
  // proxy, so several candidates are returned.
  const domains = (patterns) =>
    patterns.filter((p) => p.startsWith("*://*.") && p.endsWith("/*")).map((p) => p.slice(6, -2)).slice(0, 10);
  const all = entry("css/generic/all.css");
  const excepted = entry("css/generic/excepted.css");
  return {
    generic: await firstSimple(all.css[0]),
    excepted: await firstSimple(excepted.css[0]),
    generichideDomains: domains(all.exclude_matches),
    exceptionDomains: domains(excepted.exclude_matches.filter((p) => !all.exclude_matches.includes(p))),
  };
}

test("cosmetic filters hide matching elements with CSS, honouring domain exceptions", async () => {
  const cases = await pickCases();
  assert.ok(cases.generic && cases.excepted, "simple selectors exist in both generic stylesheets");
  assert.ok(cases.generichideDomains.length && cases.exceptionDomains.length, "excluded domains exist");
  const selectors = [
    { name: "generic", selector: cases.generic },
    { name: "excepted", selector: cases.excepted },
  ];
  const { context, close } = await launch(DIST);
  try {
    const visibility = async (url) => {
      elementPage = elementHtml(selectors);
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: "load" });
      assert.equal(response.status(), 200, `${url} loads through the proxy`);
      const result = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-test]")].map((el) => [el.dataset.test, getComputedStyle(el).display]),
        ),
      );
      result.scripts = await page.evaluate(() => document.scripts.length);
      await page.close();
      return result;
    };
    const firstLoadable = async (domains) => {
      for (const domain of domains) {
        try {
          return { domain, result: await visibility(`http://${domain}/elements.html`) };
        } catch (error) {
          console.log(`skipping ${domain}: ${error.message.split("\n")[0]}`);
        }
      }
      assert.fail(`none of ${domains} loads over HTTP`);
    };

    // Content scripts are registered shortly after the extension loads.
    let plain;
    for (let attempt = 1; attempt <= 5; attempt++) {
      plain = await visibility(`${PAGE}elements.html`);
      if (plain.generic === "none") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(plain.generic, "none", `generic ${cases.generic} hidden on news.site.test`);
    assert.equal(plain.excepted, "none", `generic ${cases.excepted} (excepted elsewhere) hidden on news.site.test`);
    assert.equal(plain.control, "block", "control element stays visible");
    assert.equal(plain.scripts, 0, "no script element was injected into the page");

    const exception = await firstLoadable(cases.exceptionDomains);
    assert.equal(exception.result.generic, "none", `generic ${cases.generic} hidden on ${exception.domain}`);
    assert.equal(exception.result.excepted, "block", `${cases.excepted} not hidden on ${exception.domain}, which excepts it`);

    const generichide = await firstLoadable(cases.generichideDomains);
    assert.equal(generichide.result.generic, "block", `${cases.generic} not hidden on $generichide site ${generichide.domain}`);
    assert.equal(generichide.result.excepted, "block", `${cases.excepted} not hidden on $generichide site ${generichide.domain}`);
    console.log(
      `generic ${cases.generic} and ${cases.excepted} hidden on news.site.test; ` +
        `${cases.excepted} shown on ${exception.domain} (#@# exception); nothing hidden on ${generichide.domain} ($generichide)`,
    );
  } finally {
    await close();
  }
});

test("every generated stylesheet parses completely in Chromium", async () => {
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8"));
  const sheets = [];
  for (const entry of manifest.content_scripts) {
    for (const file of entry.css) {
      const css = await readFile(path.join(DIST, file), "utf8");
      sheets.push({ file, css, expected: css.split(DECLARATION).length - 1 });
    }
  }
  const { context, close } = await launch(null);
  try {
    const page = await context.newPage();
    await page.goto(PAGE);
    // A rule with one invalid selector is dropped whole, so a parsed rule
    // count equal to the written rule count means every selector parsed.
    const { failures, genericParseMs } = await page.evaluate((sheets) => {
      const failures = [];
      let genericParseMs = 0;
      const style = document.createElement("style");
      document.head.append(style);
      for (const { file, css, expected } of sheets) {
        const start = performance.now();
        style.textContent = css;
        const parsed = style.sheet.cssRules.length;
        const elapsed = performance.now() - start;
        if (file === "css/generic/all.css") genericParseMs = elapsed;
        if (parsed !== expected) failures.push(`${file}: ${parsed} of ${expected} rules parsed`);
      }
      return { failures, genericParseMs };
    }, sheets);
    console.log(`${sheets.length} stylesheets parsed; generic stylesheet parse time ${genericParseMs.toFixed(1)} ms`);
    assert.deepEqual(failures, []);
  } finally {
    await close();
  }
});

test("page load time with and without the extension (informational)", async () => {
  const timings = {};
  for (const [label, dir] of [["without", null], ["with", DIST]]) {
    const { context, close } = await launch(dir);
    try {
      const page = await context.newPage();
      elementPage = elementHtml([]);
      const samples = [];
      for (let i = 0; i < 8; i++) {
        await page.goto(`${PAGE}elements.html?${i}`, { waitUntil: "load" });
        samples.push(await page.evaluate(() => performance.getEntriesByType("navigation")[0].loadEventEnd));
      }
      timings[label] = median(samples.slice(1));
      await page.close();
    } finally {
      await close();
    }
  }
  console.log(`median load of a small page: ${timings.without.toFixed(1)} ms without, ${timings.with.toFixed(1)} ms with the extension`);
});

test("both rulesets are enabled and fit Chrome's rule limits", async () => {
  const { probeDir, remove } = await makeProbe();
  const { context, close } = await launch(probeDir);
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const enabled = await worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
    const available = await worker.evaluate(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount());
    const guaranteed = await worker.evaluate(() => chrome.declarativeNetRequest.GUARANTEED_MINIMUM_STATIC_RULES);
    const browserVersion = context.browser()?.version() ?? "unknown";
    console.log(`Chromium ${browserVersion}: enabled rulesets ${enabled}, available static rules ${available}, guaranteed ${guaranteed}`);

    assert.deepEqual([...enabled].sort(), ["easylist", "easyprivacy"]);
    const report = JSON.parse(await readFile("build-report.json", "utf8"));
    const total = report.lists.reduce((n, list) => n + list.rules, 0);
    assert.ok(total <= guaranteed, `${total} rules should fit the guaranteed ${guaranteed}`);
  } finally {
    await close();
    await remove();
  }
});

// The build proves that expanding the merged rules gives back the unmerged
// conversion. This test checks the premise of the merge inside Chromium:
// requestDomains: [host] decides every request exactly like "||host^".
test("merged rulesets match the same requests as the unmerged rules", async () => {
  const unmerge = (rules) => expandMergedRules(rules).map((rule, index) => ({ id: index + 1, ...rule }));
  const merged = await makeProbe(["declarativeNetRequestFeedback"]);
  const unmerged = await makeProbe(["declarativeNetRequestFeedback"], unmerge);
  try {
    // One request per merged host, in the shape the rule is about, plus
    // look-alike hosts that must not match.
    const requests = [];
    const actions = {}; // ruleset -> { ruleId -> "priority:action" }
    for (const resource of merged.manifest.declarative_net_request.rule_resources) {
      const rules = JSON.parse(await readFile(path.join(merged.probeDir, resource.path), "utf8"));
      actions[resource.id] = Object.fromEntries(rules.map((r) => [r.id, `${r.priority}:${r.action.type}`]));
      for (const rule of rules) {
        const hosts = rule.condition.requestDomains;
        if (!hosts || rule.condition.urlFilter) continue;
        const type = rule.condition.resourceTypes?.[0] ?? "script";
        const initiator =
          rule.condition.domainType === "firstParty"
            ? null
            : rule.condition.initiatorDomains
              ? `https://${rule.condition.initiatorDomains[0]}`
              : "https://news.site.test";
        for (const host of hosts) {
          for (const url of [`https://${host}/`, `http://www.${host}/x.js?y=1`, `https://${host}.evil.test/`, `https://x${host}/`]) {
            requests.push({ url, type, initiator: initiator ?? `https://${host}` });
          }
        }
      }
    }
    const unmergedActions = {};
    for (const resource of unmerged.manifest.declarative_net_request.rule_resources) {
      const rules = JSON.parse(await readFile(path.join(unmerged.probeDir, resource.path), "utf8"));
      unmergedActions[resource.id] = Object.fromEntries(rules.map((r) => [r.id, `${r.priority}:${r.action.type}`]));
    }

    const outcomes = async (probeDir) => {
      const { context, close } = await launch(probeDir);
      try {
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
        const enabled = await worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
        assert.deepEqual([...enabled].sort(), ["easylist", "easyprivacy"], "both rulesets enabled in the probe");
        // In batches: one huge Promise.all floods the worker and gets it killed.
        const results = [];
        for (let i = 0; i < requests.length; i += 1000) {
          results.push(
            ...(await worker.evaluate(
              (batch) => Promise.all(batch.map((request) => chrome.declarativeNetRequest.testMatchOutcome(request))),
              requests.slice(i, i + 1000),
            )),
          );
        }
        return results;
      } finally {
        await close();
      }
    };
    const describe = (result, table) =>
      result.matchedRules.map(({ rulesetId, ruleId }) => `${rulesetId} ${table[rulesetId][ruleId]}`).sort().join(" | ");
    const mergedResults = (await outcomes(merged.probeDir)).map((r) => describe(r, actions));
    const unmergedResults = (await outcomes(unmerged.probeDir)).map((r) => describe(r, unmergedActions));
    const differences = [];
    let matched = 0;
    for (const [i, request] of requests.entries()) {
      if (mergedResults[i]) matched++;
      if (mergedResults[i] !== unmergedResults[i]) differences.push(`${request.url}: merged [${mergedResults[i]}] unmerged [${unmergedResults[i]}]`);
    }
    console.log(`${requests.length} requests tested against merged and unmerged rulesets, ${matched} matched a rule, ${differences.length} differences`);
    assert.deepEqual(differences.slice(0, 20), []);
    assert.ok(matched > requests.length / 4, "the merged hosts actually match");
  } finally {
    await merged.remove();
    await unmerged.remove();
  }
});

// Runs scripts/check.mjs on a copy of dist/ changed by mutate(dir, manifest)
// and expects it to fail with every given message.
async function expectCheckFailure(name, mutate, expected) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "add-block-bad-"));
  try {
    await cp(DIST, dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await mutate(dir, manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const run = promisify(execFile)(process.execPath, ["scripts/check.mjs", dir]);
    await assert.rejects(run, (error) => {
      assert.equal(error.code, 1, `${name}: check should exit 1`);
      for (const pattern of expected) assert.match(error.stderr, pattern, `${name}: expected ${pattern}`);
      return true;
    });
    console.log(`check rejects ${name}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("npm run check rejects JavaScript in pages, network APIs, remote URLs and extra code", async () => {
  const popupJs = (dir) => path.join(dir, "popup.js");
  const append = async (file, text) => writeFile(file, (await readFile(file, "utf8")) + text);

  await expectCheckFailure(
    "js in a content script",
    async (dir, manifest) => {
      manifest.content_scripts[0].js = ["inject.js"];
      await writeFile(path.join(dir, "inject.js"), "document.body.remove()");
    },
    [/JavaScript in pages is not allowed/, /script not allowed: inject.js/],
  );
  await expectCheckFailure(
    "a background worker",
    async (dir, manifest) => {
      manifest.background = { service_worker: "worker.js" };
      await writeFile(path.join(dir, "worker.js"), "");
    },
    [/no background scripts allowed/, /script not allowed: worker.js/],
  );
  for (const [name, code, pattern] of [
    ["a network call", "\nfetch('/x');\n", /popup.js: fetch is not allowed/],
    ["XMLHttpRequest", "\nnew XMLHttpRequest();\n", /XMLHttpRequest is not allowed/],
    ["a WebSocket", "\nnew WebSocket(x);\n", /WebSocket is not allowed/],
    ["an EventSource", "\nnew EventSource(x);\n", /EventSource is not allowed/],
    ["a beacon", "\nnavigator.sendBeacon(x);\n", /sendBeacon is not allowed/],
    ["importScripts", "\nimportScripts('x.js');\n", /importScripts is not allowed/],
    ["a dynamic import", "\nimport('./x.js');\n", /dynamic import\(\) is not allowed/],
    ["a remote URL in a script", "\nconst u = 'https://example.com/x';\n", /popup.js: URL in script: https:\/\/example.com\/x/],
    ["a protocol-relative URL", "\nconst u = '//example.com/x';\n", /protocol-relative URL is not allowed/],
    ["code in pages via the scripting API", "\nchrome.scripting.executeScript({});\n", /scripting API \(code in pages\) is not allowed/],
    ["eval", "\neval('1');\n", /eval is not allowed/],
  ]) {
    await expectCheckFailure(name, (dir) => append(popupJs(dir), code), [pattern]);
  }
  await expectCheckFailure(
    "a remote script in the popup page",
    async (dir) => {
      const file = path.join(dir, "popup.html");
      await writeFile(file, (await readFile(file, "utf8")).replace('<script src="popup.js">', '<script src="https://cdn.example/x.js">'));
    },
    [/popup.html: URL in page: https:\/\/cdn.example\/x.js/, /popup.html: script not allowed: https:\/\/cdn.example\/x.js/],
  );
  await expectCheckFailure(
    "an inline script in the popup page",
    async (dir) => {
      const file = path.join(dir, "popup.html");
      await writeFile(file, (await readFile(file, "utf8")).replace("</body>", "<script>alert(1)</script></body>"));
    },
    [/popup.html: inline script/],
  );
  await expectCheckFailure(
    "a second page",
    (dir) => writeFile(path.join(dir, "options.html"), "<!doctype html><title>x</title>"),
    [/page not allowed: options.html/],
  );
  await expectCheckFailure(
    "a permission outside the allowlist",
    (dir, manifest) => manifest.permissions.push("tabs"),
    [/permission not allowed: tabs/],
  );
  await expectCheckFailure(
    "a block rule with an allow rule id",
    async (dir, manifest) => {
      const file = path.join(dir, manifest.declarative_net_request.rule_resources[0].path);
      const rules = JSON.parse(await readFile(file, "utf8"));
      rules[0].id = 1_000_000 + rules.length;
      await writeFile(file, JSON.stringify(rules));
    },
    [/\(block\) is in the wrong id range/],
  );
});

// The popup needs, for the tab it was opened on, the tab's URL and
// getMatchedRules. The toolbar click grants both through activeTab; test
// automation cannot click the toolbar, so the probe gets the same two
// things for every tab from the "tabs" and "declarativeNetRequestFeedback"
// permissions instead, plus an empty worker to open the popup window.
// Chrome's own error text, logged by the test below, states the
// equivalence. The popup page and script are the ones in dist/, unchanged.
test("popup: the switch turns blocking off and on for the site, and the setting survives a restart", async () => {
  const site = "http://www.news.site.test/";
  const probe = await makeProbe(["tabs", "declarativeNetRequestFeedback"]);
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "add-block-profile-"));
  const dynamicRules = (worker) => worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  // Loads the site in its own tab and reports every resource's outcome.
  const visit = async (page) => {
    const outcomes = {};
    page.on("requestfinished", (request) => (outcomes[request.url()] ??= "ok"));
    page.on("requestfailed", (request) => (outcomes[request.url()] = request.failure()?.errorText));
    await page.goto(site, { waitUntil: "load" });
    return outcomes;
  };
  const allBlocked = (outcomes) => RESOURCES.every(({ url, blocked }) => (outcomes[url] === BLOCKED_BY_CLIENT) === blocked);
  const noneBlocked = (outcomes) => RESOURCES.every(({ url }) => outcomes[url] === "ok");

  try {
    // Session 1: blocking on, switch it off.
    let { context, close } = await launch(probe.probeDir, profileDir);
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const page = await context.newPage();
      let outcomes;
      for (let attempt = 1; attempt <= 5 && !allBlocked((outcomes = await visit(page))); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.ok(allBlocked(outcomes), "blocking works before the switch is touched");
      assert.deepEqual(await dynamicRules(worker), [], "no dynamic rules to start with");

      let popup = await openPopup(context, worker);
      await popup.waitForFunction(() => document.getElementById("count").textContent !== "–");
      let state = await popupState(popup);
      console.log(`popup on ${site}: ${JSON.stringify(state)}`);
      assert.equal(state.site, "news.site.test", "shows the site without www.");
      assert.equal(state.on, true);
      assert.equal(state.disabled, false);
      assert.equal(state.label, "Blocking on");
      assert.equal(state.offNote, false);
      assert.equal(state.count, String(BLOCKED_COUNT), "counts the blocked requests of the page");

      await popup.click("label.switch");
      await popup.waitForFunction(() => document.getElementById("switch").checked === false && !document.getElementById("switch").disabled);
      const rules = await dynamicRules(worker);
      assert.equal(rules.length, 2, "two dynamic rules for the site");
      const frameRule = rules.find((rule) => rule.action.type === "allowAllRequests");
      const requestRule = rules.find((rule) => rule.action.type === "allow");
      assert.deepEqual(frameRule.condition, { requestDomains: ["news.site.test"], resourceTypes: ["main_frame"] });
      assert.deepEqual(requestRule.condition, { initiatorDomains: ["news.site.test"] });
      for (const rule of rules) assert.ok(rule.priority > 2010, "outranks every static rule");
      // The popup reloads the tab and then shows the count for the new load.
      await popup.waitForFunction(() => document.getElementById("count").textContent === "0", null, { timeout: 15000 });
      state = await popupState(popup);
      assert.equal(state.label, "Blocking off");
      assert.equal(state.offNote, true, "explains that element hiding stays on and where to stop it");

      outcomes = await visit(page);
      assert.ok(noneBlocked(outcomes), `nothing blocked with the switch off: ${JSON.stringify(outcomes)}`);
      for (const { url } of RESOURCES) assert.ok(seen.has(url), `${url} reached the proxy`);

      // The link to Chrome's per-site extension settings opens them in a tab.
      const settingsPromise = context.waitForEvent("page", { predicate: (p) => p.url().startsWith("chrome://extensions") });
      await popup.click("#site-settings");
      const settings = await settingsPromise;
      console.log(`site settings link opened ${settings.url()}`);
      await settings.close();

      // Documented limit: the CSS still applies on a site that is off.
      elementPage = elementHtml([{ name: "generic", selector: (await pickCases()).generic }]);
      const elements = await context.newPage();
      await elements.goto(`${site}elements.html`, { waitUntil: "load" });
      const display = await elements.evaluate(() => getComputedStyle(document.querySelector("[data-test=generic]")).display);
      assert.equal(display, "none", "element hiding stays on while request blocking is off (see DESIGN.md)");
      await elements.close();
      await popup.close();
    } finally {
      await close();
    }

    // Session 2: the same profile after a restart. Still off; switch it on.
    ({ context, close } = await launch(probe.probeDir, profileDir));
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      assert.equal((await dynamicRules(worker)).length, 2, "the dynamic rules survived the restart");
      const page = await context.newPage();
      let outcomes = await visit(page);
      assert.ok(noneBlocked(outcomes), `still off after a restart: ${JSON.stringify(outcomes)}`);

      const popup = await openPopup(context, worker);
      await popup.waitForFunction(() => document.getElementById("count").textContent !== "–");
      let state = await popupState(popup);
      console.log(`popup after restart: ${JSON.stringify(state)}`);
      assert.equal(state.on, false);
      assert.equal(state.label, "Blocking off");
      assert.equal(state.count, "0");

      await popup.click("label.switch");
      await popup.waitForFunction(() => document.getElementById("switch").checked === true && !document.getElementById("switch").disabled);
      assert.deepEqual(await dynamicRules(worker), [], "the dynamic rules are removed");
      await popup.waitForFunction((n) => document.getElementById("count").textContent === n, String(BLOCKED_COUNT), { timeout: 15000 });
      state = await popupState(popup);
      assert.equal(state.label, "Blocking on");
      await popup.close();

      outcomes = await visit(page);
      assert.ok(allBlocked(outcomes), `blocking is back on: ${JSON.stringify(outcomes)}`);
    } finally {
      await close();
    }
  } finally {
    await probe.remove();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test("popup: without activeTab it names no site and says why; getMatchedRules says what it needs", async () => {
  const probe = await makeProbe();
  const { context, close } = await launch(probe.probeDir);
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const page = await context.newPage();
    await page.goto(PAGE, { waitUntil: "load" });
    // What activeTab stands in for: Chrome's error names the alternatives.
    const error = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      try {
        await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
        return null;
      } catch (e) {
        return `${e.message} (tab.url seen by the extension: ${JSON.stringify(tab.url)})`;
      }
    });
    console.log(`getMatchedRules without activeTab: ${error}`);
    assert.match(error, /activeTab/);
    assert.match(error, /declarativeNetRequestFeedback/);

    const popup = await openPopup(context, worker);
    const state = await popupState(popup);
    console.log(`popup without activeTab: ${JSON.stringify(state)}`);
    assert.equal(state.site, "Unknown site");
    assert.equal(state.disabled, true);
    assert.equal(state.count, null);
    assert.match(state.note, /toolbar button/);
    await popup.close();
  } finally {
    await close();
    await probe.remove();
  }
});

// Element hiding cannot be switched off per site by the extension (that
// would take JavaScript in pages or host permissions, see DESIGN.md).
// Chrome's site access setting for the extension can: "On specific sites"
// applies the content scripts only to the listed sites. Request blocking
// does not depend on site access, so it continues everywhere. (Chrome's
// per-site "restricted sites" list would be the direct answer, but
// developerPrivate.addUserSpecifiedSites is a no-op in this Chromium,
// with or without the ExtensionsMenuAccessControl feature.)
test("Chrome's site access setting \"On specific sites\" stops the CSS elsewhere while blocking continues", async () => {
  const { context, close } = await launch(DIST);
  try {
    const page = await context.newPage();
    await page.goto("chrome://extensions");
    const [{ id }] = await extensionsInfo(context);
    await page.evaluate(
      (id) => new Promise((resolve) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: "ON_SPECIFIC_SITES" }, resolve)),
      id,
    );
    await page.evaluate((id) => new Promise((resolve) => chrome.developerPrivate.addHostPermission(id, "http://other.site.test/*", resolve)), id);
    const [{ permissions }] = await extensionsInfo(context);
    console.log(`site access now: ${JSON.stringify(permissions.runtimeHostPermissions)}`);
    assert.equal(permissions.runtimeHostPermissions.hostAccess, "ON_SPECIFIC_SITES");
    await page.close();

    elementPage = elementHtml([{ name: "generic", selector: (await pickCases()).generic }]);
    const hidden = async (url) => {
      const p = await context.newPage();
      await p.goto(url, { waitUntil: "load" });
      const display = await p.evaluate(() => getComputedStyle(document.querySelector("[data-test=generic]")).display);
      await p.close();
      return display === "none";
    };
    for (let attempt = 1; attempt <= 5 && !(await hidden("http://other.site.test/elements.html")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(await hidden("http://other.site.test/elements.html"), true, "CSS applies on the listed site");
    assert.equal(await hidden("http://news.site.test/elements.html"), false, "no CSS on a site that is not listed");
    const outcomes = await loadPage(context);
    for (const { name, url, blocked } of RESOURCES) {
      assert.equal(outcomes[url] === BLOCKED_BY_CLIENT, blocked, `${name} on the unlisted site`);
    }
    console.log("On specific sites: generic CSS only on the listed site, requests blocked on both");
  } finally {
    await close();
  }
});
