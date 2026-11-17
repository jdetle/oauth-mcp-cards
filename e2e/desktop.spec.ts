import { expect, test, type Page } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// Desktop: the whole game sits in one window. Nothing you need is below the fold, and the
// page itself never scrolls (the timeline and a long result scroll inside their own panels).

const fits = (page: Page) => page.evaluate(() => ({ page: document.documentElement.scrollHeight, window: innerHeight }));
const inWindow = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 0;
  });

for (const [w, h] of [[1440, 900], [1280, 720], [1920, 1080]] as const) {
  test(`desktop ${w}×${h}: the whole game fits in the window`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: w, height: h });
    await createRoom(page, "Ada", "Application");
    let f = await fits(page);
    expect(f.page, "waiting room scrolls").toBeLessThanOrEqual(f.window);
    await fillWithSims(page);
    await jumpTo(page, "Learning: On-Behalf-Of");
    await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);

    // your turn: board, the slip you're deciding on, a card to play and a check to run, all on screen
    f = await fits(page);
    expect(f.page, "the page scrolls on your turn").toBeLessThanOrEqual(f.window);
    for (const sel of [".hud", ".scenario .briefing", ".board", ".terminal.me", ".wire .slip-title", ".hand-group.must .card.playable", ".hand-group.ought .card.playable", ".side .tabs"]) {
      expect(await inWindow(page, sel), `${sel} is not fully in the window`).toBe(true);
    }
    // every seat is inside the board
    const clipped = await page.evaluate(() => {
      const b = document.querySelector(".board")!.getBoundingClientRect();
      return [...document.querySelectorAll(".terminal")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1;
      }).length;
    });
    expect(clipped, "terminals clipped by the board").toBe(0);

    await playCard(page, /Exchange card/);
    await expect(result(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(300);
    f = await fits(page);
    expect(f.page, "the page scrolls on the result").toBeLessThanOrEqual(f.window);
    for (const sel of [".result h2", ".result .calls li", ".ready-bar button.primary", ".board"]) {
      expect(await inWindow(page, sel), `${sel} is not fully in the window`).toBe(true);
    }
  });
}
