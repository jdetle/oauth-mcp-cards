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
  await jumpTo(page, "Learning: On-Behalf-Of");
  // keep a finger on the screen while the sims play
  for (let i = 0; i < 12; i++) {
    await page.dispatchEvent("body", "touchstart");
    await page.waitForTimeout(100);
  }
  const pill = page.locator(".jump-pill");
  await expect(pill).toContainText("Your move");
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(40);
  await pill.click();
  await expect(page.locator(".wire")).toBeInViewport();
  await expect(pill).toHaveCount(0);
});
