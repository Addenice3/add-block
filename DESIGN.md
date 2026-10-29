# add-block design

A personal ad and tracker blocker for Chrome, Edge and Safari, built from one
Manifest V3 codebase. v0.1 targets Chrome and does network blocking only.
v0.2 adds element hiding with static CSS. v0.3 adds a toolbar popup with a
per-site switch, a blocked-request count, and icons. v0.4 adds the Safari
build: the same extension with its rulesets transformed where Apple's
documentation says Safari differs, and element hiding as a native Safari
content blocker instead of CSS content scripts (see "Safari" at the end).

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
  `import()`, workers, `eval` or the `scripting` API, and no URL at all.
  The only URL in the extension is in the popup page: the browser-internal
  `chrome://extensions/?id=` page named by the Chrome popup's "site access"
  link (a `data-url` attribute the script reads), which it can open in a
  tab. The Safari popup page has no such link and no URL.
  The manifest has no remote URLs either (`update_url`, `homepage_url`,
  remote CSP sources and the like).
- **CSS only in pages (Chrome).** The only thing the extension puts into a
  web page is static CSS from `content_scripts` entries with a `css` key.
  No `js` key, no `scripting` permission, no background worker that could
  inject anything. The stylesheets contain selectors and
  `display:none!important` and nothing else: no `@import`, no `url()`, no
  other declarations. CSS cannot read the page or send anything, so the
  extension still sees no browsing data.
- **Nothing in pages (Safari).** The Safari build has no content scripts.
  Element hiding is a Safari content blocker: a rule list that Safari
  compiles and applies by itself, made of `css-display-none` rules with
  the same selectors and the same `display: none`, and
  `ignore-previous-rules` for the sites that except them. A content blocker
  cannot read pages or send anything either, and it needs no site access.
- `npm run check` enforces this on `dist/`: only known file types
  (`.json`, `.txt`, `.png`, `.css`, `.html`, `.js`); the only page is
  `popup.html` and the only script is `popup.js`; the page loads only that
  script and bundled PNGs, with no inline script, module, `<link>`,
  `<iframe>`, event handler or `url()`, and no URL other than the allowed
  internal one; the script contains none of the network, code-loading or
  page-scripting APIs above (matched as words anywhere in the file,
  comments and strings included) and no URL at all; no URL anywhere in the
  manifest outside match patterns; rule actions limited to
  `block`/`allow`/`allowAllRequests`; URLs in rulesets only inside
  `urlFilter`/`regexFilter` match patterns; no `background`, no
  `host_permissions`, no optional permissions, no `js` in any content
  script; and every stylesheet rule re-parsed by the selector validator
  with exactly the one declaration. `npm test` proves that the check fails
  on each of these: a `js` content script, a background worker, every
  listed network API, a remote or protocol-relative URL, the `scripting`
  API, `eval`, a remote or inline script in the page, a second page, a
  permission outside the allowlist, and a rule id in the wrong range (see
  the per-site switch below).
- `npm run check` runs a second time with `--safari` on `dist-safari/`,
  with the same invariants and these on top: no `content_scripts` key and
  no stylesheet anywhere, no `chrome://` URL, no count row in the popup,
  rulesets limited to the resource types, condition names, actions and
  regex syntax Apple documents for Safari (below), and a content blocker
  made only of `css-display-none` and `ignore-previous-rules` rules whose
  selectors pass the same validator, with every hiding rule before the
  ignore rule. `npm test` proves it rejects a content script, a `chrome://`
  URL, the count row, each Chrome-only rule feature, a content blocker rule
  that blocks requests, a selector with `url()` or an unknown pseudo-class,
  a hiding rule after the ignore rule, and an ignore rule without
  `if-domain`.

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
  which can neither read nor send. There is no narrower option in Chrome:
  CSS cannot be applied to a page without matching that page, and
  `activeTab` would need a click on every page.
- Safari asks the user for access per site for the same content scripts
  (the owner saw the prompt with the v0.2 build, warning that the extension
  could read pages and browsing history). The Safari build therefore has no
  content scripts at all and gets hiding from a content blocker, which
  Safari applies without any site access. The Safari extension's
  permissions are `declarativeNetRequest` and `activeTab` only.
- `scripts/check.mjs` holds an allowlist of manifest keys and permissions. A
  new feature that needs a new key or permission has to add it to that list
  and to the log below, with the narrowest option that works. Prefer static
  rules over code, optional permissions over required ones, and
  `activeTab` over host permissions.

| Permission / manifest key | Since | Why |
| --- | --- | --- |
| `declarativeNetRequest` | 0.1 | Static rulesets. Block/allow rules need no host permissions. |
| `minimum_chrome_version: 118` | 0.1 | abp2dnr leaves out `isUrlFilterCaseSensitive: false`, which only became the default in Chrome 118. |
| `content_scripts` with `css`, `matches: ["<all_urls>"]` | 0.2 | Element hiding from EasyList's generic cosmetic filters, as static CSS. Implies site access to all sites (see above). Keys limited to `matches`, `exclude_matches`, `css`, `run_at`, `all_frames`. Chrome only: removed from the Safari build in 0.4, where a content blocker hides elements. |
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
- `dist/` is the Chrome build and loads unchanged in Edge. `dist-safari/`
  is derived from it by `scripts/safari.mjs` in the same `npm run build`,
  never from `src/` directly and never by hand: the rulesets go through
  the Safari transform, the popup page and script through two small
  patches that must each match exactly once (the build fails when a change
  to `src/` moves them), and the cosmetic step's output becomes the content
  blocker. There is no second source tree. `safari/` holds only what runs
  on the owner's Mac: the packaging script and the WebKit compile check.
- Both outputs are committed and reproducible:
  `npm run build && git diff --exit-code dist dist-safari build-report.json`.

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
                       then dist-safari/ from dist/ (scripts/safari.mjs):
                         rulesets transformed for Safari (see "Safari"),
                         manifest without content_scripts, popup patched,
                         content-blocker/blockerList.json from the generic selectors
npm run check          invariants and Chrome limits on dist/, then with --safari
                         the same plus Safari rule syntax and the content blocker
npm test               test/safari.test.mjs (no browser): dist-safari/ layout and
                         JSON, limits, the transform on fixtures and on the built
                         rulesets (regex equivalence by sampling), Chrome output
                         unchanged, check --safari rejections;
                       then Playwright + Chromium: load dist/, check blocking, hiding,
                         stylesheet parsing, merge equivalence, the popup and its
                         switch (off, on, after a restart), Chrome's site access
                         setting, and that check rejects code where it is not allowed
npm run icons          render icons/add-block.svg to src/icons/*.png and icons/add-block-512.png
safari/package.sh      on a Mac: WebKit compile check, safari-web-extension-packager,
                         content blocker wiring (see "Safari")
```

`build-report.json` records, per list, how many filters were converted,
handed to the cosmetic step, or dropped, why, with examples, and the final
rule counts; under `cosmetic`, how many selectors were used or skipped and
why; and under `safari`, per ruleset how many rules were changed or dropped
by the Safari transform and why, with example ids, plus the content
blocker's counts. It is committed, so a list update shows its effect in
the diff.

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

**Not shipped as CSS: site-specific filters** (`a.com,b.com##selector`,
10,447 filters over 7,936 domains in the pinned EasyList). CSS cannot
select on the page's host, so each distinct domain set needs its own
`content_scripts` entry with its own match patterns: 5,400 entries.
Chrome's cost grows with the number of entries. Measured in Chromium 153
with that manifest: installing the extension took 36 s and opening
chrome://extensions 45 s (with 1,000 entries, 9 s and 10 s; with the two
generic entries, 0.6 s and 0.3 s). Doing this properly means registering
content scripts for the current site from code, which is JavaScript in the
extension and in pages, and is ruled out above. The build counts them, so
a later decision can be made with numbers. The Safari content blocker
ships them: its `if-domain` trigger is exactly "on these sites" (see
"Safari").

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
  (two with the reload after a switch). When the call fails, the popup
  shows "n/a" with the reason in its tooltip. The Safari popup page has no
  count row, and the script then never calls `getMatchedRules` (Apple lists
  the function as supported, but whether `activeTab` is enough for it in
  Safari is unknown, and the owner asked for the count to be hidden).
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
  both. The popup's "site access" link opens the extension's details page
  (the page's `data-url` plus the extension id; the script holds no URL).
  In Safari the equivalent is the content blocker's own switch in Safari's
  extension settings, which the Safari popup's note names instead.
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

**Safari** has its own build, `dist-safari/`, described next.

## Safari

The Safari build is the Chrome build with three differences, all made at
build time by `scripts/safari.mjs` from `dist/` (never by hand, never from
a second source): the rulesets are transformed where Apple's documentation
says Safari differs, the CSS content scripts are replaced by a native
content blocker, and the popup loses its count and its `chrome://` link.
Everything else is identical, including the permissions
(`declarativeNetRequest`, `activeTab`).

Sources, all on developer.apple.com (webkit.org was not reachable from the
build environment): "Blocking content with your Safari web extension"
(what `declarativeNetRequest` supports in Safari), "Creating a content
blocker" (rule syntax, trigger fields, the regex table), "Packaging a web
extension for Safari" and "Running your Safari web extension" (the
packager, temporary installs, unsigned extensions), "Managing Safari web
extension permissions", and the Safari release notes (15 through 27). The
owner's own test counts as evidence too: the v0.3 Chrome build loaded as a
temporary extension in macOS Safari with no errors (Safari 16.4 and later
show `declarativeNetRequest` errors in the extension's settings pane, so
"no errors" means the rulesets loaded) and scored 97/100 on
adblock-tester.com, the same as Chrome. Since host-only rules are merged
into `requestDomains` rules and those cover the hosts that test checks,
`requestDomains` works (Safari 16.4 added it).

### Ruleset transform

Applied to every rule of both rulesets; `build-report.json` under `safari`
counts each change with example rule ids. Chrome's `dist/rulesets/` is
untouched and byte-identical to v0.3 (`npm test` checks against `main`).

| Change | Rules (v0.4 build) | Why |
| --- | ---: | --- |
| `initiatorDomains` → `domains`, `excludedInitiatorDomains` → `excludedDomains` | 955 + 161 | Apple's Safari 17.2 release notes name the conditions "domains, requestDomains, excludedDomains, and excludedRequestDomains"; Chrome's newer names appear in no Apple document. abp2dnr's Safari mode makes the same rename. The risk of leaving Chrome's names is not a load error (the owner saw none) but a rule that ignores its domain condition and blocks everywhere, so the documented names are used. |
| `csp_report`, `object`, `webbundle` removed from `resourceTypes` | 126 | Apple lists Safari's resource types as main_frame, sub_frame, stylesheet, script, image, font, xmlhttprequest, ping, media, websocket, other. The same types would be removed from `excludedResourceTypes` (none in these lists): excluding a type Safari never sees excludes nothing. |
| Rule dropped: every resource type unsupported | 2 | Two `allow` rules for `$object` only. Nothing they could match exists in Safari. |
| `allowAllRequests` limited to `main_frame` | 4 | "allowAllRequests (only for main_frame)". The four `$document` exceptions keep their main-frame effect and lose it for iframes of those hosts. |
| Regex counted quantifiers expanded | 7 | Apple's url-filter syntax table has `.`, `.*`, `\.`, `[a-b]`, `(abc)`, `+`, `*`, `?` and no `{n}`, `{n,}`, `{n,m}`. `x{3}` becomes `xxx`, `x{2,}` becomes `xx+`, `x{1,3}` becomes `xx?x?`: the same language, which `npm test` checks by sampling strings against both forms. Two regex rules needed nothing. |
| Rule dropped: regex outside the subset | 1 | `(td\|tdbank)`: alternation is not in the table. Also refused, had the lists used them: `\d`-style classes, `[^…]`, lazy quantifiers, lookaround, non-ASCII. Two things beyond the table are accepted because every URL regex needs them: a backslash before a non-alphanumeric character (`\/`, `\?`) and `^`/`$` at the ends. |

Not changed, on purpose: `isUrlFilterCaseSensitive` is left unset, because
Safari 16.4 made its default `false`, which is what the rules assume (Chrome
118 did the same); `requestDomains` and `domainType` are documented;
`priority` is kept (Safari 26 fixed its ordering). `minimum_chrome_version`
stays in the manifest: Safari ignores it and the packager only warns.
Rule ids keep their Chrome values, with gaps where rules were dropped, so
the block/allow id split holds and `npm run check --safari` verifies it.

The popup's switch rule 2 (`allow` for everything the site's pages
request) is written by the Safari popup with `domains` instead of
`initiatorDomains`, the one change to `popup.js`. Rule 1
(`allowAllRequests`, `main_frame`) is in Safari's supported subset.

### Element hiding: the content blocker

`dist-safari/content-blocker/blockerList.json` is a Safari content blocker
list built from the same cosmetic data as the Chrome CSS plus the
site-specific filters the CSS cannot carry (`buildCosmetic` returns both
as `details`). Safari compiles the list into bytecode and applies it to
every page itself; the extension never sees a page, and no site access is
involved. Mapping, in file order:

| Cosmetic data | Content blocker rule |
| --- | --- |
| 1. generic selector (`##selector`, no exceptions) | `css-display-none`, trigger `url-filter: ".*"`; 100 selectors per rule, as in the CSS |
| 2. generic selector with `#@#` or `~a.com` exceptions | `css-display-none`, trigger `url-filter: ".*"` with `unless-domain: ["*a.com", …]`, exactly its excepting domains; selectors with the same domain set share a rule |
| 3. `$generichide` or `$elemhide` exception for a host | the host in the `if-domain` of one `ignore-previous-rules` rule, which cancels rules 1 and 2 on those sites |
| 4. site-specific selector (`a.com,b.com##selector`) | `css-display-none`, trigger `url-filter: ".*"` with `if-domain: ["*a.com", "*b.com"]`, the filter's domains minus those that `#@#` excepts (a domain's exception covers its subdomains); one rule per distinct domain set, 100 selectors per rule. After rule 3 because `$generichide` switches off generic hiding only |
| 5. `$elemhide` exception for a host | a second `ignore-previous-rules` rule, placed last: `$elemhide` switches off all hiding. The pinned lists have none, so the file ends with rule 4 |
| `$generichide` exception with a path (`\|\|bing.com/search?`) | widened to the host: a domain condition cannot express a path. Four in the pinned lists. Hiding is off on all of that site rather than its search pages; nothing is hidden that a filter excepts |

Site-specific filters are skipped, and counted under
`safari.contentBlockerStats.specificFilters` in the report, when no
domain condition can express them: domains with a wildcard TLD
(`example.*`) or a single label, because `if-domain` takes hosts (236
filters, after dropping those domains from filters that also name real
ones: 337 domains); a filter that both includes and excludes domains
(none in the pinned lists; a trigger has one domain condition); a filter
excepted on a subdomain of one of its domains (1); a selector the
validator refuses (45, mostly uBO `+js(...)` snippets and `:style()`);
and a filter that a domainless `#@#` or its own domains' exceptions
remove entirely. Nothing is hidden that a filter excepts.

`*a.com` in a domain condition matches a.com and its subdomains (Apple's
"Add * in front to match domain and subdomains"); `localhost` and IP
addresses get no star. `ignore-previous-rules` cancels every rule before it
in the same list, and this list holds nothing but hiding rules, so the
ignore rules need no resource-type condition and cannot touch request
blocking (which is the web extension's separate rule list). The exceptions
are exact here, unlike Chrome's one shared file for excepted selectors: a
content blocker rule costs nothing to add, so the "coarse exceptions"
compromise above and the missing site-specific filters are Chrome-only.
`npm run check --safari` verifies the order: generic hiding rules, the
`$generichide` ignore rule, then only rules with `if-domain`, and at most
one more ignore rule.

Counts for the v0.4 build: 5,815 rules for 23,801 selectors, 1.2 MB. Of
those, 134 rules hold the 13,336 generic selectors, 275 rules the 300
excepted ones (275 domain sets), 1 ignore rule 188 `$generichide` hosts,
and 5,405 rules the 10,165 site-specific selectors (5,405 domain sets;
10,447 filters minus the 282 skipped above). That is 11.6% of the 50,000
rules enforced as the limit. WebKit rejects a whole list when one
selector or trigger is invalid, so every selector goes through the same
strict validator as the CSS (`npm run check --safari`), and
`safari/check.swift` compiles the list with `WKContentRuleListStore`, the
compiler Safari uses, before the project is built (Safari 16.4 added
`:has()` to content blockers, the newest thing the validator admits). The
site-specific filters are the most likely to hit something WebKit's
selector parser dislikes; if the compile check fails on one, the fix is
to refuse that syntax in `scripts/selector.mjs`, not to edit the output.

Like the Chrome CSS, the content blocker is not switched per site by the
popup: it is a separate extension with its own on/off switch in Safari's
settings, which is what the Safari popup's note points to.

### Safari limits

| Limit | Value | Source | Used |
| --- | --- | --- | --- |
| static rulesets | 50 | Safari 16 release notes | 2 |
| enabled static rulesets | 10 | Safari 16 release notes | 2 |
| static rules | not documented | Safari compiles DNR into content rule lists, so the content blocker limit below is the likely bound, counted per `requestDomains` entry rather than per merged rule: about 102,700 for these lists | 12,940 rules |
| regex rules per ruleset | not documented | Chrome's 1,000 kept as the check | 4 and 5 |
| content blocker rules per list | 50,000 (Safari 15 and later: 150,000, from memory, unverified) | not in any Apple page reachable here; the lower figure is enforced | 5,815 |
| dynamic rules | not documented (`MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` exists since 16.4) | Safari 16.4 release notes | 2 per site switched off |

### Packaging

Safari runs extensions only from an app. `safari/package.sh` (macOS,
Xcode) compiles the content blocker and the regex rules with WebKit
(`safari/check.swift`), runs `xcrun safari-web-extension-packager` (or the
older `safari-web-extension-converter`) on `dist-safari/extension` with
`--copy-resources`, `--macos-only`, `--swift` and the placeholder bundle
identifier `com.example.add-block`, and, once the content blocker target
exists, replaces its `blockerList.json` with ours. Adding that target is
the one thing Xcode will not do from a script: File → New → Target →
Content Blocker Extension, named `add-block Hiding`; the README has the
numbered steps, with signing ("Sign to Run Locally") and Safari's
"Allow unsigned extensions" from Apple's "Running your Safari web
extension". On later runs the script copies the current extension files
into the project instead of creating it again, so a list update is
`git pull`, `safari/package.sh`, Product → Build.

### Unverified until it runs in Safari

The build environment has no macOS, so these rest on documentation and
the owner's one test; the first run on the Mac should look at each:

- The web extension asks for no website access (no content scripts) and
  the content blocker appears as "add-block Hiding" with no prompt.
- `domains`/`excludedDomains` are honoured (a `$domain=` rule blocks on
  its site and nowhere else), and the switch's `allow` rule with
  `domains` turns blocking off for one site only. The owner's earlier
  test used the Chrome build with `initiatorDomains` and only scored
  generic rules, so it says nothing about either name. README, "Safari",
  has a step with a page and a console line for each, and what each
  result means.
- The content blocker hides the same elements as the Chrome CSS, hides
  nothing on a `$generichide` site (github.com is one) or for an excepted
  selector on its domain, and applies a site-specific filter on its site
  only (canyoublockit.com has one: the "Adblocker detected" text under
  `.elementor-widget-container > center > p` should be gone there).
- `safari/check.swift` passes, in particular the expanded regexes and the
  `^`/`$` anchors and `\/` escapes they keep.
- The `isUrlFilterCaseSensitive` default (16.4 says `false`) and what a
  rule without `resourceTypes` matches (Chrome: everything but
  `main_frame`; Safari undocumented).
- The actual rule limits; the content blocker is far below either figure.
