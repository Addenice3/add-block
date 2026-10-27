// Loads dist/ into Chromium and checks that it blocks known ad and tracker
// requests while leaving other requests alone. All traffic goes to a local
// HTTP proxy, so the test never touches the real network.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright";

const DIST = path.resolve("dist");
const PAGE = "http://news.site.test/";
const BLOCKED_BY_CLIENT = "net::ERR_BLOCKED_BY_CLIENT";

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

let proxy;
let proxyUrl;
const seen = new Set();

before(async () => {
  proxy = http.createServer((req, res) => {
    // A proxy receives absolute URLs.
    seen.add(req.url);
    const url = new URL(req.url);
    if (url.href === PAGE) {
      res.writeHead(200, { "content-type": "text/html" }).end(pageHtml());
    } else if (url.pathname.endsWith(".png")) {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    } else if (url.pathname.endsWith(".js")) {
      res.writeHead(200, { "content-type": "text/javascript" }).end("// ok\n");
    } else {
      res.writeHead(404).end();
    }
  });
  // Refuse HTTPS tunnels (browser background traffic): nothing leaves the machine.
  proxy.on("connect", (req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => new Promise((resolve) => proxy.close(resolve)));

async function launch(extensionDir) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "add-block-profile-"));
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
      await rm(userDataDir, { recursive: true, force: true });
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

test("dist/ loads cleanly and blocks ads and trackers", async () => {
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

test("both rulesets are enabled and fit Chrome's rule limits", async () => {
  // A copy of dist/ with an empty service worker, only so the test can call
  // the declarativeNetRequest API. dist/ itself has no background script.
  const probeDir = await mkdtemp(path.join(os.tmpdir(), "add-block-probe-"));
  await cp(DIST, probeDir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(probeDir, "manifest.json"), "utf8"));
  manifest.background = { service_worker: "probe.js" };
  await writeFile(path.join(probeDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(probeDir, "probe.js"), "");

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
    await rm(probeDir, { recursive: true, force: true });
  }
});
