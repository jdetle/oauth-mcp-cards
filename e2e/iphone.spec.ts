import { expect, test, type Page } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// The iPhone UX gates (docs/adversarial-review/reviews/2026-11-16-iphone-ux.md), in Safari's
// engine on an iPhone profile (the "iphone" project). Every one of these bugs passed Chrome.

/** Visible fields under 16px (iOS zooms on focus) and controls under 44pt. */
async function controls(page: Page, scope = "body") {
  return page.evaluate((scope) => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || (el as HTMLInputElement).name || "").trim().slice(0, 30)}"`;
    const root = document.querySelector(scope)!;
    const fields = [...root.querySelectorAll("input:not([type=radio]):not([type=checkbox]):not([type=range]), select, textarea")].filter(vis);
    const zoom = fields.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => `${label(el)} ${getComputedStyle(el).fontSize}`);
    // inline links inside running text are exempt (WCAG 2.5.8 "inline" exception)
    const targets = [...root.querySelectorAll("button, select, input:not([type=radio]):not([type=checkbox]):not([type=hidden]), a")]
      .filter(vis)
      .filter((el) => !(el.tagName === "A" && el.closest("p, li.tl-entry, .muted, td")));
    const small = targets.filter((el) => el.getBoundingClientRect().height < 43.5).map((el) => `${label(el)} ${Math.round(el.getBoundingClientRect().height)}px`);
    return { zoom, small };
  }, scope);
}

/** Visible text under 12px. */
async function tinyText(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("svg, .fx-layer, .sr-only")) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (own && parseFloat(cs.fontSize) < 11.95) out.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(" ")[0]} "${el.textContent!.trim().slice(0, 20)}" ${cs.fontSize}`);
    }
    return out;
  });
}

const inView = (page: Page, sel: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return `${sel}: missing`;
    const r = el.getBoundingClientRect();
    // anything fixed over the bottom of the screen hides what's under it
    const covers = [...document.querySelectorAll("body *")]
      .filter((x) => getComputedStyle(x).position === "fixed" && x.getBoundingClientRect().height > 0 && !x.closest(".fx-layer"))
      .map((x) => x.getBoundingClientRect().top)
      .filter((t) => t > 0);
    const bottom = Math.min(innerHeight, ...covers);
    return r.top >= -1 && r.bottom <= bottom + 1 ? "ok" : `${sel}: ${Math.round(r.top)}–${Math.round(r.bottom)}, visible area 0–${Math.round(bottom)}`;
  }, sel);

test("iPhone: lobby fields don't zoom and every control is a 44pt target", async ({ page }) => {
  await page.goto("./");
  const c = await controls(page);
  expect(c.zoom, "fields under 16px (iOS zooms the page on focus)").toEqual([]);
  expect(c.small, "controls under 44pt").toEqual([]);
});

test("iPhone: on your turn the slip and your first card fit on one screen; the result stays readable", async ({ page }) => {
  test.setTimeout(90_000);
  await createRoom(page, "Ada", "Application");
  await fillWithSims(page);

  const host = await controls(page, ".stack");
  expect(host.zoom, "table fields under 16px").toEqual([]);
  expect(host.small, "table controls under 44pt").toEqual([]);

  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".wire")).toBeVisible();
  await page.waitForTimeout(1500); // auto-scroll settles
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  expect(await inView(page, ".wire"), "the slip you're deciding on").toBe("ok");
  expect(await inView(page, ".card.playable"), "your first playable card").toBe("ok");
  expect(await tinyText(page), "text under 12px on your turn").toEqual([]);
  // touch screens: no "press 1–9" hint or number badges
  await expect(page.locator(".card .key").first()).toBeHidden();
  await expect(page.getByText("press 1–9")).toBeHidden();

  await playCard(page, "Forward the token");
  await expect(result(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".ready-bar")).toBeVisible();
  // (auto-scroll may offer a "Jump to" pill instead, since you just tapped: go there directly)
  await page.locator(".result").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  expect(await inView(page, ".result p"), "the result's first paragraph with the ready bar up").toBe("ok");
  const bar = await page.locator(".ready-bar").boundingBox();
  expect(bar!.height, "ready bar is one slim line").toBeLessThanOrEqual(90);
  expect(await tinyText(page), "text under 12px on the result").toEqual([]);
  // the roster is a tap away
  await page.locator(".ready-count").click();
  await expect(page.locator(".ready-roster li").first()).toBeVisible();
});

test("iPhone: first move (nothing on the wire): the question and your cards share one screen", async ({ page }) => {
  test.setTimeout(90_000);
  await createRoom(page, "Cy", "Client");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(".png", "-client.png") });
  expect(await inView(page, ".scenario .briefing"), "the question").toBe("ok");
  expect(await inView(page, ".card.playable"), "your first playable card").toBe("ok");
  // the board waits below your hand until you've played
  const order = await page.evaluate(() => {
    const y = (s: string) => document.querySelector(s)!.getBoundingClientRect().top;
    return y(".hand-panel") < y(".board");
  });
  expect(order).toBe(true);
  // no card is cut off at the side
  const clipped = await page.locator(".hand .card").evaluateAll((cs) => cs.filter((c) => c.getBoundingClientRect().right > innerWidth + 1).length);
  expect(clipped).toBe(0);
});

test.describe("iPhone SE size", () => {
  test.use({ viewport: { width: 375, height: 553 } });
  test("iPhone SE: nothing overflows sideways; your card stays on screen, with the slip above it", async ({ page }) => {
    test.setTimeout(90_000);
    await createRoom(page, "Ada", "Application");
    await fillWithSims(page);
    await jumpTo(page, "Learning: On-Behalf-Of");
    await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await inView(page, ".card.playable"), "your first playable card").toBe("ok");
    // the slip gives way at the top, but its fields are still on screen
    expect(await page.locator(".wire").evaluate((el) => el.getBoundingClientRect().bottom > 120)).toBe(true);
  });
});

test("iPhone, a scripted game: the slip and your first card share one screen; nothing tiny", async ({ page }) => {
  test.setTimeout(90_000);
  await createRoom(page, "Tia", "Tool", "Agent Security");
  await fillWithSims(page);
  const c = await controls(page, ".stack");
  expect(c.zoom, "fields under 16px").toEqual([]);
  expect(c.small, "controls under 44pt").toEqual([]);
  await jumpTo(page, "Whose Words Are These?");
  await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".wire .slip.packet")).toBeVisible();
  await page.waitForTimeout(1500);
  if (process.env.GEOM) console.log("GEOM " + JSON.stringify(await page.evaluate(() => Object.fromEntries([".wire", ".wire .slip", ".hand-panel", ".hand-group.must", ".card.playable", ".hand-group.ought"].map((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return [q, r ? [Math.round(r.top), Math.round(r.bottom)] : null]; })))));
  expect(await inView(page, ".wire .slip-title"), "the slip you're deciding on").toBe("ok");
  expect(await inView(page, ".card.playable"), "your first playable card").toBe("ok");
  expect(await tinyText(page), "text under 12px").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
