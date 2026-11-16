import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// This project runs against a server where an intruder swaps the MCP Server's token in every round.

test("skip the checks and the intruder walks in: breach, with the check that would have caught it", async ({ page }) => {
  await createRoom(page, "Trusting", "MCP Server");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  // everything upstream was done right, and the slip looks like any other sealed slip
  await expect(page.locator(".wire .slip.is-sealed .field-sealed")).toHaveCount(5, { timeout: 15_000 });
  await playCard(page, "Accept");
  await expect(result(page)).toContainText("Chain broken at MCP Server (Trusting)", { timeout: 20_000 });
  await expect(page.locator(".intrusion")).toContainText("An intruder swapped the token");
  const mine = page.locator(".calls li:has(.calls-who.r-mcp)");
  await expect(mine.locator(".dil-breach")).toBeVisible();
  await expect(result(page)).toContainText(/Checking (audience|scope|expiry|issuer|subject) would have shown it/);
  // the senders did nothing wrong
  await expect(page.locator(".calls li:has(.calls-who.r-client) .call.match")).toBeVisible();
  await page.getByRole("tab", { name: "Scoreboard" }).click();
  await expect(page.locator(".score tr", { hasText: "Trusting" }).locator(".dil-stats")).toHaveText("0/0/1");
});

test("run the checks and the intruder is caught: one field fails, Reject is the right call", async ({ page }) => {
  await createRoom(page, "Checker", "MCP Server");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  for (const check of ["Validate Audience", "Validate Scope", "Validate Expiry", "Validate Issuer", "Validate Subject"]) {
    await playCard(page, check);
  }
  const slip = page.locator(".wire .slip.is-sealed");
  await expect(slip.locator(".field-bad")).toHaveCount(1); // exactly one defect
  await expect(slip.locator(".field-ok")).toHaveCount(4);
  await playCard(page, "Reject");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(page.locator(".intrusion")).toBeVisible();
  await expect(page.locator(".calls li:has(.calls-who.r-mcp) .dil-caught")).toContainText("caught by a check");
  await expect(result(page)).toContainText("Caught it with a check");
});
