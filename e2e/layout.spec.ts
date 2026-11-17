import { expect, test, type Page } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo } from "./helpers";

// Runs in Safari's engine on an iPhone profile (the "iphone" project): the alignment bug
// only showed up there.

async function edges(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.right)]);
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      blocks: [...box(".hud"), ...box(".game > .stack > .panel"), ...box(".board"), ...box(".side > .panel")],
      terminalsInside: (() => {
        const b = document.querySelector(".board")!.getBoundingClientRect();
        return [...document.querySelectorAll(".terminal")].every((t) => {
          const r = t.getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1 && r.right <= b.right + 1;
        });
      })(),
    };
  });
}

for (const large of [false, true]) {
  test(`iPhone: every section shares the same edges, nothing overflows${large ? " (large text)" : ""}`, async ({ page }) => {
    await createRoom(page, "John");
    if (large) await page.addStyleTag({ content: "html { font-size: 125% !important; } body { font-size: 18px !important; }" });
    for (const stage of ["waiting", "playing"]) {
      if (stage === "playing") {
        await fillWithSims(page);
        await jumpTo(page, "Learning: On-Behalf-Of");
        await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
      }
      const e = await edges(page);
      expect(e.scrollWidth, `${stage}: sideways overflow`).toBeLessThanOrEqual(e.viewport);
      const lefts = new Set(e.blocks.map((b) => b[0]));
      const rights = new Set(e.blocks.map((b) => b[1]));
      expect([...lefts], `${stage}: left edges`).toHaveLength(1);
      expect([...rights], `${stage}: right edges`).toHaveLength(1);
      expect(e.terminalsInside, `${stage}: terminals clipped by the board`).toBe(true);
    }
  });
}
