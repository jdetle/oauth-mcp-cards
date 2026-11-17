import { expect, test, type Page } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// Follow-the-action only applies to the stacked (phone/tablet) layout.
test.skip(({ viewport }) => (viewport?.width ?? 2000) >= 1100, "stacked layout only");

const topOf = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!.y;

test("phone: the page follows the action to your move, then to the result @mobile", async ({ page }) => {
  await createRoom(page, "Mo", "MCP Server");
  await fillWithSims(page);
  await expect(page.getByRole("button", { name: "Auto-scroll on" })).toBeVisible();
  await jumpTo(page, "Learning: On-Behalf-Of");

  // three sims play; when it reaches me, what I'm responding to is brought to the top
  await expect(page.locator(".card.playable", { hasText: "Accept" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".wire")).toBeInViewport();
  await expect.poll(() => topOf(page, ".wire"), { timeout: 5_000 }).toBeLessThan(140);
  await expect.poll(() => topOf(page, ".wire")).toBeGreaterThan(-40);

  await playCard(page, "Accept");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(result(page)).toBeInViewport();
  await expect.poll(() => topOf(page, ".result"), { timeout: 5_000 }).toBeLessThan(140);
});

test("phone: Auto-scroll off leaves the page where you put it @mobile", async ({ page }) => {
  await createRoom(page, "Still", "MCP Server");
  await fillWithSims(page);
  await page.getByRole("button", { name: "Auto-scroll on" }).click();
  await expect(page.getByRole("button", { name: "Auto-scroll off" })).toBeVisible();
  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".card.playable", { hasText: "Accept" })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  // still parked at the top of the page: the wire panel was not brought up, and no pill nags
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(40);
  await expect(page.locator(".jump-pill")).toHaveCount(0);
  // the choice is remembered
  await page.reload();
  await expect(page.getByRole("button", { name: "Auto-scroll off" })).toBeVisible();
});

test("phone: while you're touching the screen it offers a jump instead of scrolling @mobile", async ({ page }) => {
  await createRoom(page, "Busy", "MCP Server");
  await fillWithSims(page);
  // reading the timeline further down, a finger on the screen the whole time
  await page.locator(".side").scrollIntoViewIfNeeded();
  const parked = await page.evaluate(() => {
    window.dispatchEvent(new Event("touchstart"));
    (window as any).__finger = setInterval(() => window.dispatchEvent(new Event("touchstart")), 100);
    return scrollY;
  });
  // the host jumps to a round (from the page itself, so the test doesn't scroll to the button)
  await page.evaluate(() => {
    const sel = document.querySelector<HTMLSelectElement>(".hostbar select")!;
    const opt = [...sel.options].find((o) => o.text.includes("Learning: On-Behalf-Of"))!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, opt.value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".hostbar button")].find((b) => b.textContent === "Jump")!.click());
  await expect(page.locator(".card.playable", { hasText: "Accept" })).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(500);
  // the page wasn't scrolled out from under you; a pill offers to take you to your move
  expect(Math.abs((await page.evaluate(() => scrollY)) - parked)).toBeLessThan(40);
  await page.evaluate(() => clearInterval((window as any).__finger));
  const pill = page.locator(".jump-pill");
  const wireOnScreen = await page.locator(".wire").evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
  // (a layout shift can briefly show the slip, which rightly clears the pill)
  if (!wireOnScreen && (await pill.count())) {
    await expect(pill).toContainText("Your move");
    await pill.click();
    await expect(page.locator(".wire")).toBeInViewport();
  }
  await expect(pill).toHaveCount(0);
});
