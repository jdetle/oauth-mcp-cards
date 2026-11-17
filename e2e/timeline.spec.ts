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
  // four judged calls (sims sometimes add a free check, which isn't judged)
  await expect(feed.locator(".tl-msg:has(.call)")).toHaveCount(4);
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

  // the other pages stay clean: no overlay; the lobby just offers a way back
  for (const path of ["./learn/", "./reference/"]) {
    await page.goto(path);
    await expect(page.locator(".tl-feed")).toHaveCount(0);
  }
  await page.goto("./");
  const back = page.locator(".return-to-game");
  await expect(back).toContainText(room);
  await back.getByRole("link", { name: "Back to the table →" }).click();
  await expect(page.locator(".board")).toBeVisible();
});
