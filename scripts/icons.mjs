// Renders icons/add-block.svg to PNG at every size the extension and the
// stores need, using the Chromium that Playwright already provides. Run
// `npm run icons` after changing the SVG; the PNGs are committed and
// `npm run build` only copies them.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const SOURCE = "icons/add-block.svg";
// 16/32/48/128 ship in src/icons/ (manifest icons and toolbar); 512 stays
// outside the extension for store listings and the Safari app icon.
const OUTPUTS = [
  [16, "src/icons/16.png"],
  [32, "src/icons/32.png"],
  [48, "src/icons/48.png"],
  [128, "src/icons/128.png"],
  [512, "icons/add-block-512.png"],
];

const svg = await readFile(SOURCE, "utf8");
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  for (const [size, file] of OUTPUTS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true, type: "png" });
    await writeFile(file, png);
    console.log(`${file}: ${size}x${size}, ${png.length} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`Rendered ${OUTPUTS.length} PNGs from ${path.resolve(SOURCE)}`);
