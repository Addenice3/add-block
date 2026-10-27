# add-block

A personal ad and tracker blocker for Chrome (Edge and Safari later), built
on Manifest V3 `declarativeNetRequest`. It bundles EasyList and EasyPrivacy as
static rulesets, and EasyList's generic element-hiding filters as static
CSS. It makes no network requests, runs no code (not in the extension, not
in pages), has no telemetry, and asks for a single permission:
`declarativeNetRequest`.

v0.2 blocks requests and hides leftover ad elements that EasyList's generic
cosmetic filters name. Site-specific cosmetic filters are not included (see
DESIGN.md for why). There is no popup or settings page. See
[DESIGN.md](DESIGN.md) for the invariants and decisions.

## Install in Chrome without building

`dist/` is committed, so you only need a copy of the repository.

1. Get the repository: on GitHub, **Code → Download ZIP** and unzip it, or
   run `git clone https://github.com/Addenice3/add-block.git`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `dist` folder inside the repository
   (the folder that contains `manifest.json`).
5. "add-block" now appears in the list. Its details show the permission
   "Block content on any page" (that is `declarativeNetRequest`) and site
   access "On all sites" (that is the CSS, which has to be applied to every
   page). A packaged install would word the latter as "Read and change all
   your data on all websites"; the CSS can do neither. You can restrict
   site access there; request blocking keeps working everywhere.

There is no toolbar button. To update, pull or download the repository again
and click the reload icon on the extension's card.

Edge should work the same way through `edge://extensions` → **Load unpacked**,
but it has not been tested yet.

## Sites to test on

- <https://adblock-tester.com/> loads ad and tracker scripts from known
  hosts (Google, Yandex, Amazon, analytics and error-reporting services)
  and ad banners, and scores the result out of 100. v0.1 scored 97/100.
  The request checks come from the DNR rules; v0.2 adds nothing those
  rules missed, so expect the same score, with the banner placeholders now
  hidden where EasyList has a generic selector for them.
- <https://canyoublockit.com/testing> ("extreme test") mixes third-party
  ads, which the DNR rules block, with ad units and an "Adblocker detected"
  box and interstitial overlay served from the site itself, which request
  blocking cannot touch. Expect from v0.2: third-party ad requests blocked;
  Google ad slots (`ins.adsbygoogle` and other generic ad containers)
  hidden by the generic CSS, so no empty boxes for them; the "Adblocker
  detected" box and interstitial still shown. EasyList's only filter for
  this site is site-specific
  (`canyoublockit.com##.elementor-widget-container > center > p`), which
  v0.2 does not ship, and nothing generic matches the site's own markup.
- Any ad-heavy news site. Open DevTools → **Network** and reload. Blocked
  requests show as failed with `net::ERR_BLOCKED_BY_CLIENT` (the Console
  also lists them).

## Build it yourself

Requirements: Node.js 20 or newer (tested with 22), git, and Python plus a
C++ compiler. The C++ compiler is for node-gyp, because the converter builds
RE2 as a native addon. On first install, node-gyp may download the Node.js
headers unless they are already present.

```sh
npm ci            # install the pinned converter and test tools
npm run build     # fetch the pinned lists (cached in .cache/), write dist/ and build-report.json
npm run check     # verify permissions, no code in pages, no remote URLs, Chrome rule limits
npm test          # load dist/ in Chromium (Playwright): blocking, hiding, merge check
```

`npm test` needs a Playwright Chromium: `npx playwright install chromium`.

The build is reproducible. With the same `lists.lock.json`, it gives
byte-identical output:

```sh
npm run build && git diff --exit-code dist build-report.json
```

### Updating the filter lists

```sh
npm run update-lists   # pin the newest published lists in lists.lock.json
npm run build && npm run check && npm test
```

Commit `lists.lock.json`, `dist/` and `build-report.json` together.

## Current build

Lists pinned at version 202610270115 (27 Oct 2026). Details are in
`build-report.json`.

| List | Filters | Converted | Cosmetic | Dropped | Rules | Regex rules |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| EasyList | 74,796 | 46,357 | 24,878 | 3,561 | 3,824 | 4 |
| EasyPrivacy | 56,415 | 56,338 | 37 | 40 | 9,119 | 6 |

That is 12,943 rules in total, 43% of the 30,000 static rules Chrome
guarantees to every extension. Most dropped network filters are `$popup`
(2,969) and `$document` page blocks (569), which have no DNR equivalent.

Of the 24,915 cosmetic filters, 13,636 generic selectors ship as CSS
(224 KB in two files), honouring 337 `#@#` exceptions and 163
`$generichide` exceptions. Skipped: 10,447 site-specific filters, 291
extended selectors (`#?#`), 37 in uBO/AdGuard syntax, 4 exceptions with
patterns a match pattern cannot express.

## Layout

```
src/                 everything that ships: manifest.json, THIRD_PARTY_NOTICES.txt
dist/                built extension (committed); load this folder
scripts/             update-lists, build (with cosmetic, merge, selector), check
test/                Playwright test
lists.lock.json      pinned list versions: URL, commit, date, SHA-256
build-report.json    rule counts and dropped filters by reason
```

## Licences

The bundled rulesets are converted from EasyList and EasyPrivacy. Those lists
are dual licensed under GPL v3+ and CC BY-SA 3.0+, and
`dist/THIRD_PARTY_NOTICES.txt` carries their attribution. See DESIGN.md for
details.
