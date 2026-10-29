# add-block

A personal ad and tracker blocker for Chrome and Safari (Edge untested),
built on Manifest V3 `declarativeNetRequest`. It bundles EasyList and
EasyPrivacy as static rulesets, and EasyList's generic element-hiding
filters as static CSS (Chrome) or a native content blocker (Safari). It
makes no network requests, runs no code in web pages, has no telemetry, and
asks for two permissions: `declarativeNetRequest` and `activeTab` (no
warning; used by the popup for the current tab only).

v0.4 blocks requests, hides leftover ad elements that EasyList's generic
cosmetic filters name, and has a toolbar button with a popup: the current
site, a switch to turn blocking off or on for that site, and (Chrome) the
number of requests blocked in the tab. v0.4 adds the Safari build:
`dist-safari/`, with the same rules transformed where Apple's documentation
says Safari differs, and element hiding as a Safari content blocker, so
Safari asks for no website access. Site-specific cosmetic filters are not
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

## Safari

The Safari build is two things, both committed under `dist-safari/`:

- `dist-safari/extension/`: the web extension. Same popup and rulesets as
  Chrome, minus the CSS content scripts (so Safari asks for no website
  access), with the rulesets transformed where Apple's documentation says
  Safari differs (DESIGN.md, "Safari", lists each change). The popup has no
  blocked count and no `chrome://` link.
- `dist-safari/content-blocker/blockerList.json`: a Safari content blocker
  that hides the same elements the Chrome CSS hides plus EasyList's
  site-specific filters, which Chrome cannot carry as CSS, with EasyList's
  exceptions. Safari compiles it and applies it to every page itself; it
  needs no site access and has no access to pages.

Safari runs extensions only from an app, so the extension and the content
blocker become two extension targets of a small macOS app built in Xcode.
`safari/package.sh` does what can be scripted; the rest is numbered below.
Nothing here has run in real Safari yet (the build environment has no
macOS): DESIGN.md lists what the first run on a Mac has to confirm.

### Quick test without Xcode (extension only)

Safari can load the extension folder temporarily, without the content
blocker, so this tests request blocking and the popup but not element
hiding:

1. Safari → **Settings → Advanced** → tick **Show features for web
   developers**.
2. **Settings → Developer** → tick **Allow unsigned extensions** (it resets
   when Safari quits), then **Add Temporary Extension…** and choose
   `dist-safari/extension`.
3. **Settings → Extensions** → tick add-block. Safari should not ask for
   website access: the extension has no content scripts. Blocking is on;
   open the popup from the toolbar button.

Safari removes temporary extensions after 24 hours or when it quits.

### Full install: app with extension and content blocker

Needs macOS with Xcode (the command line tools alone are not enough). The
bundle identifier is the placeholder `com.example.add-block`; set
`BUNDLE_ID=…` in the environment to use another.

1. In Terminal, in the repository: `safari/package.sh`. It compiles the
   content blocker and the regex rules with WebKit (`safari/check.swift`;
   a rejected selector would make Safari hide nothing, so this fails
   early), runs Apple's `safari-web-extension-packager` on
   `dist-safari/extension`, and writes the Xcode project to
   `build/safari/add-block/`. The packager prints the manifest keys Safari
   ignores; `minimum_chrome_version` is expected there.
2. Open `build/safari/add-block/add-block.xcodeproj` in Xcode.
3. **File → New → Target…**, choose **macOS → Content Blocker Extension**,
   **Next**.
4. Product Name: `add-block Hiding`. Keep the team, language and bundle
   identifier Xcode proposes. **Finish**. If Xcode offers to activate the
   new scheme, click **Cancel** (the app scheme builds all targets).
5. Back in Terminal: `safari/package.sh` again. It finds the new target's
   sample `blockerList.json` and replaces it with
   `dist-safari/content-blocker/blockerList.json`. (Or paste the file's
   contents over the sample in Xcode.)
6. Signing, once per target: select the project in the navigator, then
   each of the three targets (**add-block**, **add-block Extension**,
   **add-block Hiding**) → **Signing & Capabilities** → Signing
   Certificate: **Sign to Run Locally**, Team: **None**. (With an Apple
   Developer account, choose your team instead and skip step 8.)
7. Select the **add-block** scheme and **Product → Run**. Xcode builds both
   extensions into the app and launches it; the app's window has a button
   that opens Safari's extension settings. You can quit the app.
8. Safari → **Settings → Advanced** → tick **Show features for web
   developers**; **Settings → Developer** → tick **Allow unsigned
   extensions**. This resets when Safari quits: tick it again next time.
9. **Settings → Extensions**: tick **add-block** (the web extension) and
   **add-block Hiding** (the content blocker). Safari should ask the web
   extension for no website access, and the content blocker never asks.
10. Test: <https://adblock-tester.com/> (the Chrome build loaded in Safari
    scored 97/100 there, the same as in Chrome) and
    <https://canyoublockit.com/testing>. To see that hiding is the content
    blocker's: turn **add-block Hiding** off, reload, and the Google ad
    slots on canyoublockit.com come back as empty boxes. Site-specific
    hiding, new in Safari: with it on, the site's "Adblocker detected"
    text (EasyList hides `.elementor-widget-container > center > p` on
    canyoublockit.com only) is gone; Chrome still shows it.
11. Check that Safari honours the `domains` condition. The Safari build
    renames Chrome's `initiatorDomains` to `domains` in 1,116 rules and in
    the popup's switch, because Apple's release notes use that name; the
    earlier Safari test ran the Chrome build and exercised neither name,
    so this is unproven. Two checks, each with a clear reading:
    - **The switch.** On <https://canyoublockit.com/testing> click the
      add-block button and turn the switch off (the page reloads with
      ads). In a new tab open <https://adblock-tester.com/>. **97/100**
      means the switch's allow rule stayed scoped to canyoublockit.com:
      `domains` works. **About 41/100** (nothing blocked anywhere) means
      Safari ignored `domains` and the allow rule applies everywhere.
      **"Could not change the setting"** in the popup means Safari
      rejected the key. Turn the switch back on afterwards.
    - **A static rule.** EasyList rule 2008 blocks every request to
      amazonaws.com, but only on four sites (animeflv.net,
      mangakakalot.gg, nelomanga.net, uploadhaven.com). On
      <https://adblock-tester.com/>, which is not one of them, open
      **Develop → Show Web Inspector → Console** and run:

      ```js
      fetch("https://s3.amazonaws.com/", { mode: "no-cors" }).then(() => console.log("loaded"), () => console.log("blocked"))
      ```

      **loaded** means the rule stayed on its four sites: `domains`
      works. **blocked** means Safari applies the rule everywhere, so the
      Safari build over-blocks and the name must change; also look for
      errors under **Settings → Extensions → add-block**. Run the same
      line on <https://uploadhaven.com/> as the control: there it must
      print **blocked**; if it prints **loaded** on both sites, the rule
      is not reaching fetches at all and the check is inconclusive.

    Either way, report the result; the Safari build changes only if
    Safari turns out to want the other name.

To update after a list change: `git pull`, then `safari/package.sh` (it
copies the new extension files and `blockerList.json` into the project),
then in Xcode **Product → Build**, then in Safari turn **add-block Hiding**
off and on so Safari recompiles its rules. The web extension picks up the
new files on build.

## The popup

Click the add-block button on a web page:

- **This site** shows the site of the page (its host, without `www.`).
- **The switch** turns request blocking off or on for that site and its
  subdomains, then reloads the page. Off means: the page and everything in
  it, iframes included, loads unblocked. The setting is kept by the browser
  and survives restarts. Turn the switch back on to remove it.
- **Blocked in this tab** (Chrome only) counts the requests the bundled
  rules blocked since the page was opened. It is 0 on a site that is off.
  It shows "n/a" with a reason in its tooltip when the browser cannot say
  (more than 20 popup opens in 10 minutes). The Safari popup has no count
  row.

On a `chrome://` page, a file, or when the popup is opened without clicking
the button on a page, there is no site and the switch is disabled.

### Element hiding on a site that is off

The switch stops request blocking only. In Chrome the element-hiding CSS
still applies, because it is a static part of the manifest and changing
where it applies would need code in pages or broad permissions (DESIGN.md
explains). Chrome's own setting covers it: open `chrome://extensions`,
click **Details** on add-block (the popup's "site access" link takes you
there), and under **Site access** choose **On specific sites** and list the
sites where you want element hiding, or **On click** to have it only on
pages where you click the button. Request blocking does not depend on site
access and keeps working everywhere, with the switch deciding per site.
Chrome has no "all sites except this one" option for an extension.

In Safari element hiding is the separate "add-block Hiding" content
blocker, which Safari applies everywhere it is on. Turn it off for all
sites in **Safari → Settings → Extensions**; Safari has no per-site switch
for a content blocker. The popup says so when a site is off.

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
npm run build     # fetch the pinned lists (cached in .cache/), write dist/, dist-safari/ and build-report.json
npm run check     # verify permissions, code only in the popup, no network APIs or remote URLs, rule limits; Chrome and Safari builds
npm test          # Safari build (no browser needed), then dist/ in Chromium (Playwright): blocking, hiding, merge check, popup and switch
npm run test:safari  # only the Safari tests
npm run icons     # only after editing icons/add-block.svg: re-render the PNGs
```

`npm test` needs a Playwright Chromium: `npx playwright install chromium`.

The build is reproducible. With the same `lists.lock.json`, it gives
byte-identical output:

```sh
npm run build && git diff --exit-code dist dist-safari build-report.json
```

### Updating the filter lists

```sh
npm run update-lists   # pin the newest published lists in lists.lock.json
npm run build && npm run check && npm test
```

Commit `lists.lock.json`, `dist/`, `dist-safari/` and `build-report.json`
together.

## Current build

Lists pinned at version 202610270115 (27 Oct 2026). Details are in
`build-report.json`.

| List | Filters | Converted | Cosmetic | Dropped | Rules (Chrome) | Regex rules |
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

**Safari** (same lists, `build-report.json` under `safari`): 12,940 rules
after the transform (3 dropped: 2 allow rules that only matched the
`object` type, 1 regex with alternation; 1,221 changed, mostly the
`initiatorDomains` rename and resource types Safari does not have), 9 regex
rules. The content blocker has 5,815 rules for 23,801 selectors (1.2 MB):
134 generic rules for the same 13,636 selectors as the CSS, 275 rules for
the 300 selectors with exceptions (one per distinct domain set, exact
rather than Chrome's shared file), one `ignore-previous-rules` rule that
turns generic hiding off on the 188 `$generichide` sites, and 5,405 rules
for 10,165 site-specific selectors (one per distinct domain set; 282 of
the 10,447 site-specific filters are skipped: 236 name only wildcard or
single-label domains, 45 have selectors the validator refuses, 1 is
excepted on a subdomain). That is 11.6% of the 50,000 rules a content
blocker may hold (Safari 15 and later take 150,000, from memory; the
lower figure is enforced). Safari allows 50 static rulesets with 10
enabled; this uses 2.

## Layout

```
src/                 everything that ships: manifest.json, popup.html, popup.js, icons/, THIRD_PARTY_NOTICES.txt
dist/                built Chrome extension (committed); load this folder
dist-safari/         built Safari extension (extension/) and content blocker (content-blocker/blockerList.json), committed
safari/              package.sh (runs on the owner's Mac) and check.swift (WebKit compile check)
icons/               add-block.svg (icon source) and the 512 px PNG for stores
scripts/             update-lists, build (with cosmetic, merge, selector, safari), check, icons
test/                safari.test.mjs (no browser) and extension.test.mjs (Playwright, Chromium)
lists.lock.json      pinned list versions: URL, commit, date, SHA-256
build-report.json    rule counts and dropped filters by reason, Chrome and Safari
```

## Licences

The bundled rulesets and the Safari content blocker are converted from
EasyList and EasyPrivacy. Those lists are dual licensed under GPL v3+ and
CC BY-SA 3.0+, and `THIRD_PARTY_NOTICES.txt` in `dist/` and
`dist-safari/extension/` carries their attribution; it covers
`blockerList.json` too. See DESIGN.md for details.
