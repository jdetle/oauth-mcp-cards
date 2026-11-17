// Renders public/og.png (the link-preview image) and public/apple-touch-icon.png.
//   node scripts/og/render.mjs
import { chromium } from "@playwright/test";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "../../public");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.goto(`file://${here}/og.html`);
await p.screenshot({ path: `${pub}/og.png` });
const tmp = `${here}/.icon.html`;
writeFileSync(tmp, `<body style="margin:0;background:#04060d"><img src="file://${pub}/favicon.svg" width="180" height="180" style="display:block"></body>`);
const q = await b.newPage({ viewport: { width: 180, height: 180 } });
await q.goto(`file://${tmp}`);
await q.screenshot({ path: `${pub}/apple-touch-icon.png` });
rmSync(tmp);
await b.close();
console.log("wrote public/og.png and public/apple-touch-icon.png");
