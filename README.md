# add-block

A personal ad and tracker blocker for Chrome (Edge and Safari later), built
on Manifest V3 `declarativeNetRequest`. It bundles EasyList and EasyPrivacy as
static rulesets, and EasyList's generic element-hiding filters as static
CSS. It makes no network requests, runs no code in web pages, has no
telemetry, and asks for two permissions: `declarativeNetRequest` and
`activeTab` (no warning; used by the popup for the current tab only).

v0.3 blocks requests, hides leftover ad elements that EasyList's generic
cosmetic filters name, and has a toolbar button with a popup: the current
site, a switch to turn blocking off or on for that site, and the number of
requests blocked in the tab. Site-specific cosmetic filters are not
included (see DESIGN.md for why). See [DESIGN.md](DESIGN.md) for the
invariants and decisions.

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
6. Click the puzzle icon in the toolbar and pin add-block to see its button.

To update, pull or download the repository again and click the reload icon
on the extension's card. Sites you switched off stay off: the setting is
stored by the browser, not in the extension's files.

Edge should work the same way through `edge://extensions` → **Load unpacked**,
but it has not been tested yet.

## The popup

Click the add-block button on a web page:

- **This site** shows the site of the page (its host, without `www.`).
- **The switch** turns request blocking off or on for that site and its
  subdomains, then reloads the page. Off means: the page and everything in
  it, iframes included, loads unblocked. The setting is kept by the browser
  and survives restarts. Turn the switch back on to remove it.
- **Blocked in this tab** counts the requests the bundled rules blocked
  since the page was opened. It is 0 on a site that is off. It shows "n/a"
  with a reason in its tooltip when the browser cannot say (Safari, or
  more than 20 popup opens in 10 minutes).

On a `chrome://` page, a file, or when the popup is opened without clicking
the button on a page, there is no site and the switch is disabled.

### Element hiding on a site that is off

The switch stops request blocking only. The element-hiding CSS still
applies, because it is a static part of the manifest and changing where it
applies would need code in pages or broad permissions (DESIGN.md explains).
Chrome's own setting covers it: open `chrome://extensions`, click
**Details** on add-block (the popup's "site access" link takes you there),
and under **Site access** choose **On specific sites** and list the sites
where you want element hiding, or **On click** to have it only on pages
where you click the button. Request blocking does not depend on site
access and keeps working everywhere, with the switch deciding per site.
Chrome has no "all sites except this one" option for an extension.

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
npm run check     # verify permissions, code only in the popup, no network APIs or remote URLs, Chrome rule limits
npm test          # load dist/ in Chromium (Playwright): blocking, hiding, merge check, popup and switch
npm run icons     # only after editing icons/add-block.svg: re-render the PNGs
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
Block rules have ids from 1, allow rules from 1,000,000, so the popup can
tell them apart in `getMatchedRules` results.

Of the 24,915 cosmetic filters, 13,636 generic selectors ship as CSS
(224 KB in two files), honouring 337 `#@#` exceptions and 163
`$generichide` exceptions. Skipped: 10,447 site-specific filters, 291
extended selectors (`#?#`), 37 in uBO/AdGuard syntax, 4 exceptions with
patterns a match pattern cannot express.

## Layout

```
src/                 everything that ships: manifest.json, popup.html, popup.js, icons/, THIRD_PARTY_NOTICES.txt
dist/                built extension (committed); load this folder
icons/               add-block.svg (icon source) and the 512 px PNG for stores
scripts/             update-lists, build (with cosmetic, merge, selector), check, icons
test/                Playwright test
lists.lock.json      pinned list versions: URL, commit, date, SHA-256
build-report.json    rule counts and dropped filters by reason
```

## Licences

The bundled rulesets are converted from EasyList and EasyPrivacy. Those lists
are dual licensed under GPL v3+ and CC BY-SA 3.0+, and
`dist/THIRD_PARTY_NOTICES.txt` carries their attribution. See DESIGN.md for
details.
