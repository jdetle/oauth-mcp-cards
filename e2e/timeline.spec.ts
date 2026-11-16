import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

test("timeline keeps a timestamped record of every move across rounds, on every page", async ({ page }) => {
  const room = await createRoom(page, "Rec");
  await fillWithSims(page);
  const feed = page.locator(".tl-feed");
  await expect(page.locator(".tl-strip")).toContainText("no moves yet");

  // round A: a win
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(feed.locator(".tl-msg")).toHaveCount(4);
  await expect(feed.locator(".tl-msg").first()).toContainText("Client");
  await expect(feed.locator(".tl-msg").first().locator("time")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);

  // round B. Seats rotate, so I'm the Application now. Round A stays in the record.
  await jumpTo(page, "Learning: OAuth Passthrough");
  await expect(feed.locator(".tl-round")).toHaveCount(2);
  await expect(feed.locator(".tl-round").first()).toContainText("Round 4 · Learning: On-Behalf-Of");
  await expect(feed.locator(".tl-round").first()).toContainText("held");
  await expect(feed.locator(".tl-round").nth(1)).toContainText("live");
  await playCard(page, "Forward the token");
  await expect(result(page)).toBeVisible({ timeout: 20_000 });

  // one tick per move, across both rounds
  const ticks = page.locator(".tl-strip i");
  expect(await ticks.count()).toBeGreaterThanOrEqual(7);
  await expect(ticks.first()).toHaveAttribute("title", /^\d{2}:\d{2}:\d{2} · Client \(Rec\): Send the request/);

  // the record survives a reload (it is the server's, not the tab's)
  await page.reload();
  await expect(feed.locator(".tl-round")).toHaveCount(2);
  await expect(feed.locator(".tl-msg").first()).toContainText("Send the request to the Application");

  // and it follows you to the other pages as a dock
  for (const path of ["/learn/", "/reference/", "/"]) {
    await page.goto(path);
    const dock = page.locator(".feed-dock");
    await expect(dock).toContainText(room);
    await dock.getByRole("button").click();
    await expect(dock.locator(".tl-round")).toHaveCount(2);
    await expect(dock.getByRole("link", { name: "Back to the table →" })).toBeVisible();
  }
  await page.locator(".feed-dock").getByRole("link", { name: "Back to the table →" }).click();
  await expect(page.locator(".board")).toBeVisible();
});
