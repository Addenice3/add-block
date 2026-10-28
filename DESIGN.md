# add-block design

A personal ad and tracker blocker for Chrome, Edge and Safari, built from one
Manifest V3 codebase. v0.1 targets Chrome and does network blocking only.
v0.2 adds element hiding with static CSS. v0.3 adds a toolbar popup with a
per-site switch, a blocked-request count, and icons.

## Invariants

Every change, including every later feature, is checked against these. If a
change needs to break one, update this file first and say why.

### 1. No network, no remote code, no telemetry

- The extension makes no network requests of its own, loads no remote code
  and reports nothing to anyone.
- Blocking uses `declarativeNetRequest` (DNR) static rulesets. The browser
  matches requests against the rules itself; the extension never sees URLs,
  page content or any other browsing data. No `webRequest`, no
  `declarativeNetRequestFeedback`, no host permissions.
- **JavaScript only in the extension's own popup.** Since v0.3 `dist/`
  holds one page (`popup.html`) and one script (`popup.js`), which run only
  when the toolbar button is clicked, inside the extension's own popup.
  There is no background worker (nothing runs between clicks) and no code
  in web pages. The script uses none of `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `sendBeacon`, `importScripts`, dynamic
  `import()`, workers, `eval` or the `scripting` API, and no remote URL; the
  only URL it knows is the browser-internal `chrome://extensions/?id=` page
  it can open in a tab.
  The manifest has no remote URLs either (`update_url`, `homepage_url`,
  remote CSP sources and the like).
- **CSS only in pages.** The only thing the extension puts into a web page
  is static CSS from `content_scripts` entries with a `css` key. No `js`
  key, no `scripting` permission, no background worker that could inject
  anything. The stylesheets contain selectors and `display:none!important`
  and nothing else: no `@import`, no `url()`, no other declarations. CSS
  cannot read the page or send anything, so the extension still sees no
  browsing data.
- `npm run check` enforces this on `dist/`: only known file types
  (`.json`, `.txt`, `.png`, `.css`, `.html`, `.js`); the only page is
  `popup.html` and the only script is `popup.js`; the page loads only that
  script and bundled PNGs, with no inline script, module, `<link>`,
  `<iframe>`, event handler or `url()`; the script contains none of the
  network, code-loading or page-scripting APIs above (matched as words
  anywhere in the file, comments and strings included) and no URL other
  than the allowed internal one; no URL anywhere in the manifest outside
  match patterns; rule actions limited to `block`/`allow`/`allowAllRequests`;
  URLs in rulesets only inside `urlFilter`/`regexFilter` match patterns; no
  `background`, no `host_permissions`, no optional permissions, no `js` in
  any content script; and every stylesheet rule re-parsed by the selector
  validator with exactly the one declaration. `npm test` proves that the
  check fails on each of these: a `js` content script, a background worker,
  every listed network API, a remote or protocol-relative URL, the
  `scripting` API, `eval`, a remote or inline script in the page, a second
  page, a permission outside the allowlist, and a rule id in the wrong
  range (see the per-site switch below).

### 2. Minimum permissions

- The extension asks for `declarativeNetRequest` and `activeTab` in
  `permissions`: no host permissions, no `tabs`, no `storage`, no
  `declarativeNetRequestFeedback`, no background worker. `activeTab` has no
  install warning. It gives the popup, for the one tab the button was
  clicked on and until that tab navigates elsewhere, the tab's URL and the
  right to ask which rules matched in it. Chrome's own error message names
  the alternative: `declarativeNetRequestFeedback`, whose warning is "Read
  your browsing history" and which covers every tab, all the time.
- The CSS content scripts match `<all_urls>`. Chrome counts that as site
  access ("On all sites" in the extension's details, where the user can
  restrict it to chosen sites or to a click). A packaged install shows the
  warning "Read and change all your data on all websites" for it. The
  warning describes what a content script *could* do; this one is CSS,
  which can neither read nor send. There is no narrower option: CSS cannot
  be applied to a page without matching that page, and `activeTab` would
  need a click on every page.
- `scripts/check.mjs` holds an allowlist of manifest keys and permissions. A
  new feature that needs a new key or permission has to add it to that list
  and to the log below, with the narrowest option that works. Prefer static
  rules over code, optional permissions over required ones, and
  `activeTab` over host permissions.

| Permission / manifest key | Since | Why |
| --- | --- | --- |
| `declarativeNetRequest` | 0.1 | Static rulesets. Block/allow rules need no host permissions. |
| `minimum_chrome_version: 118` | 0.1 | abp2dnr leaves out `isUrlFilterCaseSensitive: false`, which only became the default in Chrome 118. |
| `content_scripts` with `css`, `matches: ["<all_urls>"]` | 0.2 | Element hiding from EasyList's generic cosmetic filters, as static CSS. Implies site access to all sites (see above). Keys limited to `matches`, `exclude_matches`, `css`, `run_at`, `all_frames`. |
| `activeTab` | 0.3 | The popup needs the current tab's site (its URL) and its matched rules. No warning; granted per click, per tab. Content scripts on `<all_urls>` do not expose tab URLs (tested), so there is no way around it. |
| `action` (`default_popup`, `default_icon`, `default_title`) | 0.3 | The toolbar button and its popup. Keys limited to those three. |
| `icons` | 0.3 | Toolbar, extension list, stores. Bundled PNGs only. |

Chrome's wording, unchanged from v0.2 and asserted by `npm test`:
permission message "Block content on any page" (`declarativeNetRequest`)
and site access "On all sites" (the CSS content scripts; a packaged
install words it "Read and change all your data on all websites").
`activeTab`, `action` and `icons` add no message.

### 3. Pinned, reproducible filter lists

- EasyList and EasyPrivacy are downloaded, converted and bundled at build
  time by `scripts/build.mjs`. The extension never updates them itself.
- `lists.lock.json` (committed) pins each list: source URL, commit, list
  version and date from the list header, fetch date, byte size and SHA-256.
- `npm run update-lists` is the only command that moves the pins. `npm run
  build` only downloads the pinned URLs (cached in `.cache/lists/`) and stops
  if the SHA-256 does not match.
- The converter and every other build dependency are pinned to exact
  versions in `package-lock.json`.
- Build output has no timestamps and rule ids follow list order, so a rebuild
  from the same pins gives byte-identical files. To check:
  `npm run build && git diff --exit-code dist build-report.json`.
- **Source.** easylist.to has no versioned URLs (the same URL serves a new
  list every few hours). The pins point at the gh-pages branch of the
  official EasyList repository (github.com/easylist/easylist), which holds
  the published lists, through commit-pinned `raw.githubusercontent.com`
  URLs that never change. easylist.to was also unreachable from the
  environment where this pipeline was first set up. `canonicalUrl` in the
  lock file still records the easylist.to address for reference.
- **Risk.** If EasyList ever rewrites the gh-pages history, an old pinned
  commit could disappear. The build then fails loudly rather than producing
  different output. Run `update-lists` again, or commit the raw lists if that
  becomes a problem.

### 4. One source folder

- `src/` holds everything that ships in the extension: the manifest, the
  popup page and script, the icon PNGs and the licence notice. The build
  copies it to `dist/`, adds the generated rulesets and stylesheets, and
  appends the generated `content_scripts` entries to the manifest. Nothing
  in `dist/` is edited by hand. The icon PNGs are rendered from
  `icons/add-block.svg` by `npm run icons` (Playwright's Chromium) and
  committed; `npm run build` only copies them.
- `dist/` is the same for every browser. Only packaging differs: a zip of
  `dist/` for Chrome and Edge, and an Xcode app wrapping `dist/` for Safari.
- If Safari needs a different rule dialect (see below), that is a
  packaging-time transform of the generated rulesets, not a second source
  tree.

### 5. Licences

- **EasyList and EasyPrivacy** are dual licensed, at the user's option, under
  GPL v3 or later and CC BY-SA 3.0 or later (easylist.to/pages/licence.html).
  The rulesets in `dist/rulesets/` are converted from them, which makes them
  derived works. Anyone who passes on `dist/` (including by publishing this
  repository or a store listing) must follow one of those licences: keep the
  attribution, say what was changed, share alike. `dist/THIRD_PARTY_NOTICES.txt`
  does this for the bundled files.
- **@eyeo/abp2dnr** and its adblockpluscore dependency are GPL-3.0. They run
  at build time only and are not bundled.
- **Playwright** (Apache-2.0) is only used for tests.
- The project's own licence is still to be chosen.

## Build pipeline

```
npm run update-lists   resolve the newest gh-pages commit, download, write lists.lock.json
npm run build          for each pinned list:
                         fetch pinned bytes (cache or download) and verify SHA-256
                         convert each network filter with abp2dnr
                         drop what DNR cannot do without extra permissions
                         remove duplicate rules
                         merge host-only rules into requestDomains rules
                         check that expanding the merge gives the unmerged rules back
                         number block rules from 1 and allow rules from 1,000,000
                       turn the generic cosmetic filters of all lists into CSS
                       write dist/rulesets/<id>.json, dist/css/generic/*.css,
                         dist/manifest.json (with content_scripts) and build-report.json
npm run check          invariants and Chrome limits, on dist/
npm test               Playwright + Chromium: load dist/, check blocking, hiding,
                         stylesheet parsing, merge equivalence, the popup and its
                         switch (off, on, after a restart), Chrome's site access
                         setting, and that check rejects code where it is not allowed
npm run icons          render icons/add-block.svg to src/icons/*.png and icons/add-block-512.png
```

`build-report.json` records, per list, how many filters were converted,
handed to the cosmetic step, or dropped, why, with examples, and the final
rule counts; and under `cosmetic`, how many selectors were used or skipped
and why. It is committed, so a list update shows its effect in the diff.

## Converter: @eyeo/abp2dnr

Choice: `@eyeo/abp2dnr` 1.3.3, used through its per-filter `convertFilter`
API.

Why:
- It is written by eyeo, who maintain Adblock Plus. EasyList is written in
  Adblock Plus filter syntax, and abp2dnr uses the same parser
  (adblockpluscore), so the syntax is read the way the list authors intend.
- The per-filter API throws a typed error for each filter it cannot convert,
  so every dropped filter can be counted and explained.
- It checks regex filters with RE2, the library Chrome uses for
  `isRegexSupported`, so rules Chrome would reject never get into the rulesets.
- It runs offline and gives the same output for the same input.
- Its core has a Safari mode, which will help with the Safari port.

Costs:
- It builds a native addon (RE2) with node-gyp at `npm install`, which needs
  Python and a C++ compiler.
- `npm audit` reports old transitive dependencies (`tar`, `uuid`, `mocha`).
  They are build-time only and never reach the extension.

Alternatives considered:
- AdGuard's tsurlfilter declarative converter: pure JS and maintained, but it
  targets AdGuard's syntax and has a much bigger API.
- uBlock Origin Lite's ruleset builder: strong, but it is built into uBO's
  build scripts, not a standalone package.
- Chromium's built-in `filter_list_converter`: has not kept up with DNR
  syntax changes, according to the abp2dnr README.

## Rule post-processing

Applied by `scripts/build.mjs` after conversion:

1. **Keep only actions that need no host permissions:** `block`, `allow` and
   `allowAllRequests`. `redirect` (`$rewrite`) and `modifyHeaders` (`$csp`)
   are dropped and counted.
2. **Remove exact duplicate rules.**
3. **Merge host-only rules** (`scripts/merge.mjs`). A rule whose only URL
   condition is `||host^` matches that host and its subdomains on any path,
   port and scheme. That is exactly what `requestDomains` matches. Rules that
   differ only in that host (same action, priority, resource types, party
   and initiator domains) are merged into one rule with a `requestDomains`
   list. IP addresses and single-label hosts are left alone. This changes
   nothing about what gets blocked and cuts the total from about 103k rules
   to about 13k.
4. **Merge check.** Two checks guard the claim that the merge changes
   nothing. The build expands every merged rule back into one `||host^`
   rule per listed host and fails unless the result is, as a multiset,
   exactly the unmerged conversion (rule order is the only difference, and
   DNR decides between rules by priority, not order). `npm test` then loads
   both versions into Chromium in turn and asks
   `declarativeNetRequest.testMatchOutcome` about four URLs for every merged
   host (the host, a subdomain with a path, and two look-alike hosts that
   must not match), about 360,000 requests, and fails on any difference. In
   the v0.2 run there was none.
5. **Ids by action.** Block rules are numbered from 1 in list order, allow
   and `allowAllRequests` rules from 1,000,000. The popup learns about
   blocked requests only as matched rule ids (`getMatchedRules` gives
   `rulesetId` and `ruleId`, nothing else), and it has no way to read a
   static ruleset without `fetch`, which it may not use. The id range says
   whether a matched rule blocked the request. `npm run check` verifies the
   split; the constant lives in `build.mjs`, `check.mjs` and `popup.js`.

## Element hiding: generic cosmetic filters as CSS

`scripts/cosmetic.mjs` turns EasyList's cosmetic filters into two
stylesheets and two `content_scripts` entries, and nothing else:

| Filter | Becomes |
| --- | --- |
| `##selector` | a selector in `css/generic/all.css`, matched on `<all_urls>` |
| `a.com#@#selector`, `~a.com##selector` | the selector moves to `css/generic/excepted.css`, whose entry has `exclude_matches` for every domain that excepts any generic selector |
| `#@#selector` without a domain | the selector is dropped |
| `@@\|\|a.com^$generichide` or `$elemhide` (also `\|\|a.com/path`, `$domain=`) | `*://*.a.com/*` in the `exclude_matches` of both entries |

Selectors are grouped 100 per rule. One invalid selector would make a
browser drop the whole rule, so every selector goes through
`scripts/selector.mjs`, a strict parser that accepts standard selector
syntax and a fixed list of pseudo-classes (`:not`, `:is`, `:where`, `:has`
without nesting, `:nth-*`, and the usual simple ones), and `npm test`
confirms in Chromium that every written rule is parsed. The stylesheets
are injected at `document_start` in all frames; Chromium applies them after
the page's own stylesheets, so a page `!important` does not win, but an
inline `style="display:block!important"` does.

**Not shipped: site-specific filters** (`a.com,b.com##selector`, 10,447
filters over 7,936 domains in the pinned EasyList). CSS cannot select on the
page's host, so each distinct domain set needs its own `content_scripts`
entry with its own match patterns: 5,400 entries. Chrome's cost grows with
the number of entries. Measured in Chromium 153 with that manifest:
installing the extension took 36 s and opening chrome://extensions 45 s
(with 1,000 entries, 9 s and 10 s; with the two generic entries, 0.6 s
and 0.3 s). Doing this properly means registering content scripts for the
current site from code, which is JavaScript in the extension and in pages,
and is ruled out above. The build counts them, so a later decision can be
made with numbers.

**Coarse exceptions.** Only 300 generic selectors have `#@#` exceptions,
on 475 domains. Exact handling needs one entry per distinct set of
excepting domains (276 entries, each repeating the 189 `$generichide`
patterns), with the install cost above. Instead all 300 share
`excepted.css`, excluded on all 475 domains. On those domains some generic
selectors that only another site excepted are not applied either. Nothing
is hidden that a filter says to leave alone.

**Also skipped:** extended selectors (`#?#`, `:-abp-has`, `:-abp-contains`,
`:-abp-properties`; 291), uBO/AdGuard syntax such as `##+js(...)` and
`:style()` (37), and `$generichide` exceptions whose pattern is not a host
or path prefix (`@@://10.0.0.$generichide`; 4). Counts are in
`build-report.json` under `cosmetic.skippedByReason`.

**Cost per page.** The generic stylesheet is 220 KB (13,636 selectors) and
Chromium parses it in about 6 ms. In the test, a trivial page loads in a
median of 15 ms without the extension and 27 ms with it. The styles reach
every frame, so pages with many iframes pay that per frame.

## Popup and per-site switch

The toolbar button opens `popup.html`, which shows the current site, a
switch for request blocking on that site, and the number of requests
blocked in the tab. Everything it needs is already in the browser, which is
why there is no background worker and no `storage` permission:

- **Site.** `tabs.query({ active: true, lastFocusedWindow: true })` gives
  the tab; its `url` is visible because the click that opened the popup
  granted `activeTab` for that tab. The site is the URL's host without a
  leading `www.`; only `http` and `https` pages have a switch. Opened any
  other way (or on a `chrome://` or `file:` page) the popup says so and
  disables the switch.
- **Switch = dynamic rules.** A site that is off has two dynamic
  `declarativeNetRequest` rules, both with priority 1,000,000 (every static
  rule is at 2,010 or below, which `npm run check` verifies):
  1. `allowAllRequests` for `main_frame` requests with `requestDomains:
     [site]`. Once the page's own request has matched, the browser allows
     every request in that frame hierarchy, nested iframes included.
  2. `allow` for requests with `initiatorDomains: [site]`, all resource
     types. Rule 1 works through the browser's per-frame bookkeeping, and
     in the test the first requests of a fast, cached page load were
     sometimes evaluated before that bookkeeping caught up and got blocked.
     Rule 2 is matched request by request and closes the gap for requests
     the site's own documents make.

  Both cover the site's subdomains. The browser stores dynamic rules, so
  the setting survives restarts, and the popup reads the state back from
  `getDynamicRules()` rather than keeping a list of its own. Turning a site
  on removes its rules. After a change the popup reloads the tab. Chrome
  allows 30,000 dynamic rules (`MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES`;
  `allow` and `allowAllRequests` count as "safe", so the 5,000 limit for
  unsafe rules does not apply): 15,000 sites off, which nobody will reach.
- **Count.** `getMatchedRules({ tabId })` lists the rules matched for the
  tab, which `activeTab` permits for that tab. The popup counts matches of
  static rules with a block id (see "Ids by action"); matches of allow
  rules and of the switch's own rules are not blocked requests. Chrome
  keeps matches for the tab's current document and drops older ones after
  five minutes, so the number is "since this page was opened" and can
  include a few from a page the tab showed shortly before. Chrome limits
  the call to 20 per 10 minutes per extension; a popup open costs one call
  (two with the reload after a switch). When the call fails, or the API is
  missing (Safari), the popup shows "n/a" with the reason in its tooltip.
  The alternative, `declarativeNetRequestFeedback`, would give the same
  count for every tab at all times with the warning "Read your browsing
  history", so it is not used.
- **Element hiding is not switched.** The CSS is a static `content_scripts`
  entry, and nothing short of the `scripting` permission plus host
  permissions, or a background worker that registers content scripts, can
  change where a static entry applies. Both are ruled out above. What the
  switch turns off is request blocking; the popup says so when a site is
  off. Chrome's own site access setting for the extension does the rest:
  `chrome://extensions` → add-block → Details → Site access → "On specific
  sites" applies the content scripts only to the listed sites (or "On
  click" applies them only where the button is clicked), and request
  blocking does not depend on site access, so it keeps working everywhere.
  `npm test` sets "On specific sites" through `chrome.developerPrivate` and
  checks exactly that: CSS on the listed site only, requests blocked on
  both. The popup's "site access" link opens the extension's details page.
  Chrome has no per-extension "all sites except this one" option. Chrome's
  per-site "restricted sites" list would be the direct answer, but the API
  behind it (`developerPrivate.addUserSpecifiedSites`) is a no-op in the
  Chromium used for the tests, with or without the
  `ExtensionsMenuAccessControl` feature, so it is not documented as a route.

Test automation cannot click the toolbar button (`action.openPopup()` from
a worker opens the popup but does not grant `activeTab`, and a keyboard
command sent through the DevTools protocol does not reach Chrome's
accelerators), so the popup tests load a copy of `dist/` with the `tabs` and
`declarativeNetRequestFeedback` permissions, which give every tab what
`activeTab` gives the clicked one, plus an empty worker that opens
`popup.html` in an unfocused window. The popup page and script are the
shipped ones, unchanged. A second test loads a copy without those
permissions and checks the popup's "no site" state and Chrome's error text
for `getMatchedRules`.

## Icons

`icons/add-block.svg` is original artwork for this project: a blue tile
with a white "no" sign. `npm run icons` renders it with Playwright's
Chromium to `src/icons/{16,32,48,128}.png` (manifest `icons` and the
toolbar `default_icon`) and `icons/add-block-512.png` (store listings and
the Safari app icon; not shipped in `dist/`). The PNGs are committed and
only change when the script is run.

## Chrome limits

| Limit (`chrome.declarativeNetRequest`) | Value | Used |
| --- | --- | --- |
| `GUARANTEED_MINIMUM_STATIC_RULES` | 30,000 | 12,943 (43%) |
| Shared global static pool beyond that | 300,000 for all extensions | not needed |
| `MAX_NUMBER_OF_REGEX_RULES` (per ruleset) | 1,000 | 4 and 6 |
| `MAX_NUMBER_OF_STATIC_RULESETS` | 100 | 2 |
| `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` | 50 | 2 |
| `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` | 30,000 | 2 per site switched off |
| `MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL` | 20 per 10 minutes | 1 per popup open, 2 per switch |

Staying under the guaranteed 30,000 means both rulesets are always enabled,
whatever other extensions are installed. In the test run, Chromium 153
reported 317,057 static rules still available: 17,057 of the guarantee plus
the 300,000 shared pool. `npm run check` warns when a list
update goes past it.

## Not blocked

These have no DNR equivalent, or would need permissions or code that the
extension does not have (counts are in `build-report.json`):

- Site-specific cosmetic filters, extended selectors (`#?#`) and snippets:
  see the element hiding section.
- `$popup`: DNR cannot tell a popup from a normal navigation.
- `$document` page blocks: abp2dnr does not convert them.
- `$rewrite`/`$redirect`, `$csp`: need host permissions.
- uBO-only options in EasyPrivacy (`$important`, `$redirect`, `$method`).

## Edge and Safari notes

**Edge** uses the same Chromium engine, the same DNR implementation and the
same limits. `dist/` should load unchanged through edge://extensions → Load
unpacked. For the Edge Add-ons store, upload a zip of `dist/`.

**Safari** needs work beyond packaging:
- Packaging: `xcrun safari-web-extension-converter dist/` produces an Xcode
  project. That needs macOS and Xcode, and the extension ships inside a
  small app. The store and Xcode also want icons: `src/icons/` has 16 to
  128 and `icons/add-block-512.png` the large one.
- Rule dialect: abp2dnr's Safari mode rewrites `allowAllRequests` to
  `allow`, `initiatorDomains` to `domains` and `excludedInitiatorDomains` to
  `excludedDomains`, and drops `webbundle`. That suggests Safari lacks these
  features, at least in some versions. The Safari package should be built
  with that mode, as a transform in the packaging step.
- To check on the target Safari version before relying on it: support for
  `requestDomains` (the merged rules depend on it), the regex subset Safari
  accepts, the default for `isUrlFilterCaseSensitive` (the rules assume
  case-insensitive), and Safari's rule-count limits (Safari compiles DNR into
  WebKit content rule lists, so a merged rule may count as many rules).
- Safari ignores `minimum_chrome_version`.
- Content script CSS: Safari web extensions support `content_scripts` with
  `css`, `exclude_matches`, `all_frames` and `run_at`, and the stylesheets
  only use selectors WebKit supports (`:has()` since Safari 15.4). Safari
  asks the user to allow the extension on each site (or all sites); the CSS
  only applies where it is allowed, the DNR rules apply everywhere. Safari
  also has a native alternative, a content blocker `css-display-none`
  action, that does not need any site access; a Safari package could
  convert the stylesheets into that at packaging time.
- Popup: Safari supports `action` popups, `activeTab`, `tabs.query`,
  `tabs.reload` and dynamic DNR rules (`updateDynamicRules`,
  `getDynamicRules`), so the switch should work. Safari's dynamic rule
  limit is lower than Chrome's (check it; two rules per site). Safari's
  Safari-mode conversion turns `allowAllRequests` into `allow`; the
  per-request `allow` rule (rule 2) then carries the switch. Safari has no
  `getMatchedRules`, so the count shows "n/a" with that reason. The "site
  access" link opens a `chrome://` page and does nothing in Safari; Safari's
  own per-site permission prompt is the equivalent. Safari also shows its
  own permission wording for `activeTab` and the content scripts.
