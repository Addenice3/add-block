# add-block

A personal ad and tracker blocker for Chrome (Edge and Safari later), built
on Manifest V3 `declarativeNetRequest`. It bundles EasyList and EasyPrivacy as
static rulesets. It makes no network requests, runs no code, has no
telemetry, and asks for a single permission: `declarativeNetRequest`.

v0.1 blocks at the network level only. There is no popup or settings page,
and no element hiding, so pages can still show empty boxes where ads would
have been. See [DESIGN.md](DESIGN.md) for the invariants and decisions.

## Install in Chrome without building

`dist/` is committed, so you only need a copy of the repository.

1. Get the repository: on GitHub, **Code → Download ZIP** and unzip it, or
   run `git clone https://github.com/Addenice3/add-block.git`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `dist` folder inside the repository
   (the folder that contains `manifest.json`).
5. "add-block" now appears in the list. Chrome may say it can "block content
   on any page". That is what the `declarativeNetRequest` permission means.

There is no toolbar button. To update, pull or download the repository again
and click the reload icon on the extension's card.

Edge should work the same way through `edge://extensions` → **Load unpacked**,
but it has not been tested yet.

## Sites to test on

- <https://d3ward.github.io/toolz/adblock> runs requests to known ad and
  tracker hosts and scores how many get blocked. This is a good fit for
  network blocking.
- <https://adblock-tester.com/> tests a mix of things. The network checks
  should pass. Cosmetic checks will not, by design.
- <https://canyoublockit.com/> has ad test pages. Expect the ads to be gone,
  possibly leaving empty boxes.
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
npm run check     # verify permissions, no remote code/URLs, Chrome rule limits
npm test          # load dist/ in Chromium (Playwright) and check blocking
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

| List | Filters | Converted | Dropped | Rules | Regex rules |
| --- | ---: | ---: | ---: | ---: | ---: |
| EasyList | 74,796 | 46,357 | 28,439 | 3,824 | 4 |
| EasyPrivacy | 56,415 | 56,338 | 77 | 9,119 | 6 |

That is 12,943 rules in total, 43% of the 30,000 static rules Chrome
guarantees to every extension. Most dropped filters are cosmetic (24,748),
followed by `$popup` (2,969) and `$document` page blocks (569). These have no
network-only equivalent.

## Layout

```
src/                 everything that ships: manifest.json, THIRD_PARTY_NOTICES.txt
dist/                built extension (committed); load this folder
scripts/             update-lists, build, check
test/                Playwright test
lists.lock.json      pinned list versions: URL, commit, date, SHA-256
build-report.json    rule counts and dropped filters by reason
```

## Licences

The bundled rulesets are converted from EasyList and EasyPrivacy. Those lists
are dual licensed under GPL v3+ and CC BY-SA 3.0+, and
`dist/THIRD_PARTY_NOTICES.txt` carries their attribution. See DESIGN.md for
details.
