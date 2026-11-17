import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, PASSWORD, playCard, result } from "./helpers";

// The test server runs with READY_TIMEOUT_MS=20000 (the real default is three minutes).

test("solo: one click on I'm ready starts the next round", async ({ page }) => {
  await createRoom(page, "Solo");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });

  const bar = page.locator(".ready-bar");
  await expect(bar).toBeVisible();
  await expect(bar.locator(".ready-roster li")).toHaveCount(1); // sims aren't asked
  await expect(bar.locator(".ready-roster li")).toContainText("Solo (you)");
  await expect(bar.locator(".ready-clock")).toHaveText(/^0:(1\d|20)$/);
  await bar.getByRole("button", { name: "I'm ready" }).click();
  await expect(page.locator(".hud-label")).toContainText("Learning 5/28");
  await expect(page.locator(".ready-bar")).toHaveCount(0);
  await expect(page.locator(".hud-me .role-chip")).toHaveText("Application"); // seats rotated
});

test("two people: the next round waits for both, and each sees the other ready", async ({ page, browser }) => {
  const room = await createRoom(page, "Ann");
  await fillWithSims(page);
  const ctx = await browser.newContext();
  const ben = await ctx.newPage();
  await ben.goto("./");
  const row = ben.locator(".room-item", { hasText: room });
  await row.getByRole("button", { name: "Join" }).click();
  await row.getByLabel("Display name").fill("Ben");
  await row.getByLabel("Room password").fill(PASSWORD);
  await row.getByLabel("Seat").selectOption({ label: "MCP Server" });
  await row.getByRole("button", { name: "Join room" }).click();
  await ben.waitForURL(/\/play\//);

  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await playCard(ben, "Accept");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });

  const annBar = page.locator(".ready-bar");
  const benBar = ben.locator(".ready-bar");
  await expect(annBar.locator(".ready-roster li")).toHaveCount(2);
  await annBar.getByRole("button", { name: "I'm ready" }).click();
  // Ben sees Ann ready; the round hasn't moved on without him
  await expect(benBar.locator("li.ready")).toContainText("Ann");
  await expect(benBar.locator("li.waiting")).toContainText("Ben (you)");
  await expect(page.locator(".hud-label")).toContainText("Learning 4/28");
  // Ann can change her mind
  await annBar.getByRole("button", { name: "Not yet" }).click();
  await expect(benBar.locator("li.waiting")).toHaveCount(2);
  await annBar.getByRole("button", { name: "I'm ready" }).click();
  await benBar.getByRole("button", { name: "I'm ready" }).click();
  await expect(page.locator(".hud-label")).toContainText("Learning 5/28");
  await expect(ben.locator(".hud-label")).toContainText("Learning 5/28");
  await expect(page.locator(".tl-feed")).toContainText("Everyone's ready. On to the next round.");
  await ctx.close();
});

test("nobody clicks: the table moves on by itself after the idle timeout", async ({ page }) => {
  test.setTimeout(60_000);
  await createRoom(page, "Idle");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  const started = Date.now();
  await expect(page.locator(".ready-bar")).toBeVisible();
  await expect(page.locator(".hud-label")).toContainText("Learning 5/28", { timeout: 30_000 });
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThan(17_000);
  expect(waited).toBeLessThan(26_000);
  await expect(page.locator(".tl-feed")).toContainText("No one moved for 20 seconds");
});
