import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, PASSWORD } from "./helpers";

test("the host can end the game early: the room closes for everyone and is gone @mobile", async ({ page, browser }) => {
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

  // only the host has the control
  await expect(ben.getByRole("button", { name: "End game" })).toHaveCount(0);

  // two taps; the first only asks, and "Keep playing" backs out
  await page.getByRole("button", { name: "End game" }).click();
  await expect(page.getByText("End the game for everyone and close this room?")).toBeVisible();
  await page.getByRole("button", { name: "Keep playing" }).click();
  await expect(page.locator(".hud-room b")).toHaveText(room);
  await expect(ben.locator(".hud-room b")).toHaveText(room);

  await page.getByRole("button", { name: "End game" }).click();
  await page.getByRole("button", { name: "Yes, end it" }).click();
  for (const p of [page, ben]) {
    await expect(p.getByText("The host ended this game. The room is closed.")).toBeVisible();
    await expect(p.getByRole("link", { name: /Back to the lobby/ })).toBeVisible();
  }

  // gone from the lobby, and the old link no longer opens a table
  await ben.goto("./");
  await expect(ben.locator(".room-item", { hasText: room })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".hud-room")).toHaveCount(0);
  await ctx.close();
});
