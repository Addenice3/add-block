// The popup behind the toolbar button. This is the only script in the
// extension, and it runs only in this page, never in a web page. It needs
// nothing that is not already in the browser:
// - the current tab and its URL: activeTab, granted by the click that opened
//   the popup, for that tab only;
// - the per-site switch: a dynamic declarativeNetRequest rule per site that
//   is off. The browser stores dynamic rules, so they survive restarts and
//   the popup reads them back instead of keeping its own list;
// - the blocked count: getMatchedRules for the current tab, which activeTab
//   also allows (otherwise it needs declarativeNetRequestFeedback, whose
//   warning is "Read your browsing history"). The Safari popup page has no
//   count row, and this script then never asks.
// The script holds no URL. The one page it can open, the extension's own
// details page in the browser's settings, is named by the page's "site
// access" link, which the Safari popup page does not have.
"use strict";

const dnr = chrome.declarativeNetRequest;

// scripts/build.mjs gives block rules ids below this and allow rules ids
// from here on (checked by scripts/check.mjs), so a matched rule's id says
// whether the request was blocked.
const FIRST_ALLOW_RULE_ID = 1000000;
// Above every static rule's priority (2010 at most), so the switch wins.
const SWITCH_PRIORITY = 1000000;
const $ = (id) => document.getElementById(id);
const siteText = $("site");
const siteLabel = $("site-label");
const toggle = $("switch");
const countRow = $("count-row");
const countText = $("count");
const note = $("note");
const offNote = $("off-note");
const siteSettings = $("site-settings");

// The site a tab belongs to: its host without a leading "www.". A switch
// rule on that host also covers its subdomains.
function siteOf(url) {
  try {
    const { protocol, hostname } = new URL(url ?? "");
    if (protocol !== "http:" && protocol !== "https:") return null;
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Two rules per site that is off, both above every static rule:
// - allowAllRequests for the site's pages: once the page's own request has
//   matched, everything in that frame hierarchy is allowed, iframes included;
// - allow for every request the site's pages make. The first rule is
//   applied through the browser's per-frame bookkeeping, and the first
//   requests of a fast (cached) page load can slip past it; this one is
//   matched request by request and closes that gap.
function switchRules(ids, site) {
  return [
    {
      id: ids[0],
      priority: SWITCH_PRIORITY,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: [site], resourceTypes: ["main_frame"] },
    },
    {
      id: ids[1],
      priority: SWITCH_PRIORITY,
      action: { type: "allow" },
      condition: { domains: [site] },
    },
  ];
}

const ruleSite = (rule) => rule.condition?.requestDomains?.[0] ?? rule.condition?.domains?.[0];

async function findSwitchRules(site) {
  const rules = await dnr.getDynamicRules();
  return { rules, siteRules: rules.filter((rule) => ruleSite(rule) === site) };
}

async function setBlocking(site, on) {
  const { rules, siteRules } = await findSwitchRules(site);
  const removeRuleIds = siteRules.map((rule) => rule.id);
  if (on) {
    if (removeRuleIds.length) await dnr.updateDynamicRules({ removeRuleIds });
    return;
  }
  const used = new Set(rules.map((rule) => rule.id));
  const ids = [];
  for (let id = 1; ids.length < 2; id++) if (!used.has(id)) ids.push(id);
  await dnr.updateDynamicRules({ removeRuleIds, addRules: switchRules(ids, site) });
}

// Blocked requests in the tab: matched static rules with a block id.
// Matches of the switch rule itself (ruleset "_dynamic") and of allow rules
// do not count.
async function blockedCount(tabId) {
  const { rulesMatchedInfo } = await dnr.getMatchedRules({ tabId });
  return rulesMatchedInfo.filter(
    ({ rule }) => !rule.rulesetId.startsWith("_") && rule.ruleId < FIRST_ALLOW_RULE_ID,
  ).length;
}

async function showCount(tabId) {
  if (!countRow) return;
  countRow.hidden = false;
  try {
    if (typeof dnr.getMatchedRules !== "function") throw new Error("not supported by this browser");
    countText.textContent = String(await blockedCount(tabId));
    countText.title = "Requests blocked by the bundled rules since this page was opened";
  } catch (error) {
    countText.textContent = "n/a";
    countText.title = `Count not available: ${error.message}`;
  }
}

function showState(on) {
  toggle.checked = on;
  toggle.disabled = false;
  siteLabel.textContent = on ? "Blocking on" : "Blocking off";
  offNote.hidden = on;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const site = siteOf(tab?.url);
  if (!site) {
    siteText.textContent = tab?.url ? "Not a website" : "Unknown site";
    note.textContent = tab?.url
      ? "The switch is for http and https pages."
      : "Open this from the toolbar button while on a web page to see its switch.";
    return;
  }
  siteText.textContent = site;
  const { siteRules } = await findSwitchRules(site);
  showState(siteRules.length === 0);
  await showCount(tab.id);

  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      await setBlocking(site, toggle.checked);
      showState(toggle.checked);
      note.textContent = "Reloading the page…";
      if (countText) countText.textContent = "–";
      await chrome.tabs.reload(tab.id);
    } catch (error) {
      note.textContent = `Could not change the setting: ${error.message}`;
      toggle.disabled = false;
    }
  });

  // After the reload, show the count for the new page load.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === tab.id && change.status === "complete") {
      note.textContent = "";
      showCount(tab.id);
    }
  });

  // Opens the browser's details page for this extension in a tab (its URL
  // is the link's data-url plus the extension id); never loaded here.
  siteSettings?.addEventListener("click", () => chrome.tabs.create({ url: siteSettings.dataset.url + chrome.runtime.id }));
}

main().catch((error) => {
  note.textContent = `Something went wrong: ${error.message}`;
});
