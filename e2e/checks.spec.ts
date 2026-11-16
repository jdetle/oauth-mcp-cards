import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// Required vs optional: a receiver has to respond, and ought to check. This server has no intruder.

test("a sealed token shows only what you check; trusting blind works and is marked unverified", async ({ page }) => {
  await createRoom(page, "Blind", "MCP Server");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");

  // the hand separates what you have to do from what you ought to do
  const must = page.locator(".hand-group.must");
  const ought = page.locator(".hand-group.ought");
  await expect(must.locator(".card.playable", { hasText: "Accept" })).toBeVisible({ timeout: 15_000 });
  await expect(must.locator(".hand-group-head")).toContainText("Have to do");
  await expect(ought.locator(".hand-group-head")).toContainText("Ought to do");
  await expect(ought.locator(".card")).toHaveCount(5);

  // the token on the wire is sealed: every field is hidden
  const slip = page.locator(".wire .slip.is-sealed");
  await expect(slip).toBeVisible();
  await expect(slip.locator(".field-sealed")).toHaveCount(5);
  await expect(slip).not.toContainText("calendar.read");
  await expect(slip).toContainText("Nothing forces a check");

  // one check reveals one field
  await playCard(page, "Validate Scope");
  await expect(slip.locator(".field-ok")).toContainText("calendar.read");
  await expect(slip.locator(".field-sealed")).toHaveCount(4);

  // accept without the rest: it works
  await playCard(page, "Accept");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  const mine = page.locator(".calls li:has(.calls-who.r-mcp)");
  await expect(mine.locator(".dil-unverified")).toContainText("trusted unchecked");
  await expect(mine.locator(".dil-unverified")).toContainText("audience");
  await expect(page.locator(".tl-feed")).toContainText("nothing forced a check");
  await page.getByRole("tab", { name: "Scoreboard" }).click();
  await expect(page.locator(".score tr", { hasText: "Blind" }).locator(".dil-stats")).toHaveText("0/1/0");
});

test("checking everything first is marked verified and earns a bonus", async ({ page }) => {
  await createRoom(page, "Careful", "MCP Server");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  for (const check of ["Validate Audience", "Validate Scope", "Validate Expiry", "Validate Issuer", "Validate Subject"]) {
    await playCard(page, check);
  }
  const slip = page.locator(".wire .slip.is-sealed");
  await expect(slip.locator(".field-ok")).toHaveCount(5);
  await expect(slip).toContainText("Every relevant field has been checked");
  await playCard(page, "Accept");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(page.locator(".calls li:has(.calls-who.r-mcp) .dil-verified")).toBeVisible();
  await expect(result(page)).toContainText("Verified before trusting");
  await page.getByRole("tab", { name: "Scoreboard" }).click();
  await expect(page.locator(".score tr", { hasText: "Careful" }).locator(".dil-stats")).toHaveText("1/0/0");
});

test("warm-ups stay open: nothing is sealed and no extra checks are dealt", async ({ page }) => {
  await createRoom(page, "Warm", "MCP Server");
  await fillWithSims(page);
  await jumpTo(page, "Warm-up 2: The Wrong Door");
  const slip = page.locator(".wire .slip");
  await expect(slip).toContainText("Application", { timeout: 15_000 }); // the audience is plainly visible
  await expect(page.locator(".slip.is-sealed")).toHaveCount(0);
});
