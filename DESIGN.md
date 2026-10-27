# add-block design

A personal ad and tracker blocker for Chrome, Edge and Safari, built from one
Manifest V3 codebase. v0.1 targets Chrome and does network blocking only.

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
- v0.1 contains no executable code at all: `dist/` is a manifest, two JSON
  rulesets and a licence notice.
- If code is added later, it must not use `fetch`, `XMLHttpRequest`,
  `WebSocket`, `sendBeacon`, remote `import`/`importScripts`, or remote URLs
  in pages or the manifest (`update_url`, `homepage_url`, remote CSP sources
  and the like).
- `npm run check` enforces this on `dist/`: only data files (`.json`, `.txt`,
  `.png`), no URL anywhere in the manifest, rule actions limited to
  `block`/`allow`/`allowAllRequests`, and URLs in rulesets only inside
  `urlFilter`/`regexFilter` match patterns.

### 2. Minimum permissions

- v0.1 asks for `declarativeNetRequest` and nothing else: no host
  permissions, no content scripts, no background worker, no popup.
- `scripts/check.mjs` holds an allowlist of manifest keys and permissions. A
  new feature that needs a new key or permission has to add it to that list
  and to the log below, with the narrowest option that works. Prefer static
  rules over code, optional permissions over required ones, and
  `activeTab` over host permissions.

| Permission / manifest key | Since | Why |
| --- | --- | --- |
| `declarativeNetRequest` | 0.1 | Static rulesets. Block/allow rules need no host permissions. |
| `minimum_chrome_version: 118` | 0.1 | abp2dnr leaves out `isUrlFilterCaseSensitive: false`, which only became the default in Chrome 118. |

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
  to `dist/` and adds the generated rulesets. Nothing in `dist/` is edited by
  hand.
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
                         convert each filter with abp2dnr
                         drop what DNR cannot do without extra permissions
                         remove duplicate rules
                         merge host-only rules into requestDomains rules
                       write dist/rulesets/<id>.json and build-report.json
npm run check          invariants and Chrome limits, on dist/
npm test               Playwright + Chromium: load dist/, check blocking
```

`build-report.json` records, per list, how many filters were converted or
dropped, why, with examples, and the final rule counts. It is committed, so a
list update shows its effect in the diff.

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
3. **Merge host-only rules.** A rule whose only URL condition is
   `||host^` matches that host and its subdomains on any path. That is exactly
   what `requestDomains` matches. Rules that differ only in that host (same
   action, priority, resource types, party and initiator domains) are merged
   into one rule with a `requestDomains` list. IP addresses and single-label
   hosts are left alone. This changes nothing about what gets blocked and
   cuts the total from about 103k rules to about 13k.

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

## Not blocked in v0.1

These have no DNR equivalent, or would need permissions or code that v0.1
does not have (counts are in `build-report.json`):

- Cosmetic filters (`##`, `#@#`, `#?#`, scriptlets): need content scripts.
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
