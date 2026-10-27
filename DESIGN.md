# add-block design

A personal ad and tracker blocker for Chrome, Edge and Safari, built from one
Manifest V3 codebase. v0.1 targets Chrome and does network blocking only.
v0.2 adds element hiding with static CSS.

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
- The extension contains no executable code at all: `dist/` is a manifest,
  two JSON rulesets, two CSS files and a licence notice.
- If code is added later, it must not use `fetch`, `XMLHttpRequest`,
  `WebSocket`, `sendBeacon`, remote `import`/`importScripts`, or remote URLs
  in pages or the manifest (`update_url`, `homepage_url`, remote CSP sources
  and the like).
- **CSS only in pages.** The only thing the extension puts into a web page
  is static CSS from `content_scripts` entries with a `css` key. No `js`
  key, no `scripting` permission, no background worker that could inject
  anything. The stylesheets contain selectors and `display:none!important`
  and nothing else: no `@import`, no `url()`, no other declarations. CSS
  cannot read the page or send anything, so the extension still sees no
  browsing data.
- `npm run check` enforces this on `dist/`: only data files (`.json`, `.txt`,
  `.png`, `.css`), no URL anywhere in the manifest outside match patterns,
  rule actions limited to `block`/`allow`/`allowAllRequests`, URLs in
  rulesets only inside `urlFilter`/`regexFilter` match patterns, no
  `background`, no `js` in any content script, and every stylesheet rule
  re-parsed by the selector validator with exactly the one declaration.
  `npm test` proves that the check fails on a `js` entry.

### 2. Minimum permissions

- The extension asks for `declarativeNetRequest` and nothing else in
  `permissions`: no host permissions, no background worker, no popup.
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

- `src/` holds everything that ships in the extension. The build copies it
  to `dist/`, adds the generated rulesets and stylesheets, and appends the
  generated `content_scripts` entries to the manifest. Nothing in `dist/`
  is edited by hand.
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
                       turn the generic cosmetic filters of all lists into CSS
                       write dist/rulesets/<id>.json, dist/css/generic/*.css,
                         dist/manifest.json (with content_scripts) and build-report.json
npm run check          invariants and Chrome limits, on dist/
npm test               Playwright + Chromium: load dist/, check blocking, hiding,
                         stylesheet parsing, merge equivalence, and that check rejects js
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

## Chrome limits

| Limit (`chrome.declarativeNetRequest`) | Value | v0.1 uses |
| --- | --- | --- |
| `GUARANTEED_MINIMUM_STATIC_RULES` | 30,000 | 12,943 (43%) |
| Shared global static pool beyond that | 300,000 for all extensions | not needed |
| `MAX_NUMBER_OF_REGEX_RULES` (per ruleset) | 1,000 | 4 and 6 |
| `MAX_NUMBER_OF_STATIC_RULESETS` | 100 | 2 |
| `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` | 50 | 2 |

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
  small app. The store and Xcode also want icons, which v0.1 does not have.
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
