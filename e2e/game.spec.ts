import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, PASSWORD, playCard, result } from "./helpers";

test("lobby → create room → fill with sims → win an OBO round @smoke", async ({ page }) => {
  await createRoom(page, "Ada");
  await expect(page.getByRole("heading", { name: "Waiting for four players" })).toBeVisible();
  await fillWithSims(page);
  await expect(page.locator(".terminal")).toHaveCount(4);
  await expect(page.locator(".terminal.me .t-name")).toContainText("Ada");

  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".hud-label")).toContainText("Learning 4/28");
  await expect(page.locator(".scenario .flow")).toContainText("On-Behalf-Of");

  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(result(page)).toContainText("exchanges the user's token");
  // one point per correct call, for me and for each sim
  await expect(page.locator(".terminal.me .t-score")).toContainText("01 pts");
  await page.getByRole("tab", { name: "Scoreboard" }).click();
  await expect(page.locator(".score tbody tr")).toHaveCount(4);
  // every hop is on the chain, and the cards have cleaned up after themselves
  await expect(page.locator(".chain li")).toHaveCount(3);
  await expect(page.locator(".fx-card")).toHaveCount(0, { timeout: 15_000 });
});

test("a wrong call breaks the chain and marks where", async ({ page }) => {
  await createRoom(page, "Bea");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "Skip the Application");
  await expect(result(page)).toContainText("Chain broken at Client (Bea)", { timeout: 20_000 });
  await expect(result(page)).toContainText("Traps played");
  await expect(page.locator(".terminal.fell")).toHaveCount(1);
  await expect(page.locator(".terminal.fell .fault-tag")).toHaveText("chain broke here");
  await expect(page.locator(".bit-glyph")).toBeVisible();
  // the host can replay
  await page.getByRole("button", { name: "Replay", exact: true }).first().click();
  await expect(result(page)).toHaveCount(0);
});

test("signed assertions show seals; private keys never reach the page", async ({ page }) => {
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  await createRoom(page, "Cy", "Identity Provider");
  await fillWithSims(page);
  // public keys of the table are shown as seals
  await expect(page.locator(".keyring svg")).toHaveCount(2);

  await jumpTo(page, "Learning: JWT Authorization Grant");
  // sims play Client and Application; the signed assertion arrives at me (the IdP)
  const slip = page.locator(".wire .slip", { hasText: "signed assertion" });
  await expect(slip).toBeVisible({ timeout: 15_000 });
  await expect(slip.locator(".slip-seals svg")).toHaveCount(2);
  await expect(slip).toContainText("never leaves it");
  // free check, then the real call
  await playCard(page, "Registered Key");
  await expect(page.locator(".log")).toContainText("Signature verifies");
  await playCard(page, "Issue");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });

  const state = JSON.parse(frames.filter((f) => f.includes('"t":"state"')).at(-1)!);
  expect(state.state.keys.application).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(state)).not.toMatch(/secretKey|secret_key|sigv4Secret/);
});

test("assessment: flow is classified, guesses are private, then revealed", async ({ page }) => {
  await createRoom(page, "Dee");
  await fillWithSims(page);
  await jumpTo(page, "Assessment 1");
  await expect(page.locator(".scenario .flow.classified")).toBeVisible();
  await expect(page.locator(".scenario h2")).not.toContainText("Support");
  const choices = page.getByRole("radiogroup");
  await expect(choices.getByRole("radio")).toHaveCount(10);
  // mine is the last guess in, so the picker closes as soon as it lands
  await choices.getByLabel("On-Behalf-Of (token exchange)").click();
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(result(page)).toContainText("✓ Dee: On-Behalf-Of");
  await expect(result(page)).toContainText("Identified the flow");
  await expect(page.locator(".scenario .flow")).toContainText("On-Behalf-Of");
});

test("a second person takes over a sim's seat and never sees the host's cards", async ({ page, browser }) => {
  const room = await createRoom(page, "Host");
  await fillWithSims(page);

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const guest = await ctx.newPage();
  await guest.goto("/");
  const row = guest.locator(".room-item", { hasText: room });
  await row.getByRole("button", { name: "Join" }).click();

  // wrong password first
  await row.getByLabel("Display name").fill("Guest");
  await row.getByLabel("Room password").fill("nope-nope");
  await row.getByRole("button", { name: "Join room" }).click();
  await expect(row.getByRole("alert")).toHaveText("Wrong password.");

  await row.getByLabel("Room password").fill(PASSWORD);
  await row.getByLabel("Seat").selectOption({ label: "MCP Server" });
  await row.getByRole("button", { name: "Join room" }).click();
  await guest.waitForURL(/\/play\//);
  await expect(guest.locator(".hud-me .role-chip")).toHaveText("MCP Server");
  await expect(page.locator(".terminal .sim-tag")).toHaveCount(2);
  await expect(page.locator(".terminal.r-mcp .t-name")).toContainText("Guest");

  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".card", { hasText: "Skip the Application" })).toBeVisible();
  await expect(guest.locator(".card", { hasText: "Validate Audience" })).toBeVisible();
  // hands are private in both directions
  await expect(guest.locator(".card", { hasText: "Skip the Application" })).toHaveCount(0);
  await expect(page.locator(".card", { hasText: "Validate Audience" })).toHaveCount(0);

  await playCard(page, "with the user's token slip");
  await playCard(guest, "Validate Audience");
  await expect(guest.locator(".log")).toContainText('Audience is "mcp"');
  await playCard(guest, "Accept");
  await expect(result(guest)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(result(page)).toContainText("Chain unbroken");

  // reload keeps the seat (signed cookie)
  await guest.reload();
  await expect(guest.locator(".hud-me .role-chip")).toHaveText(/Client|MCP Server/);
  await expect(guest.locator(".hud-me b")).toHaveText("Guest");
  await ctx.close();
});

test("someone without the cookie is asked for the password", async ({ page, browser }) => {
  const room = await createRoom(page, "Owner");
  const ctx = await browser.newContext();
  const stranger = await ctx.newPage();
  await stranger.goto(`/play/?room=${room}`);
  await expect(stranger.getByText("Enter the room password to join.")).toBeVisible();
  await expect(stranger.locator(".board")).toHaveCount(0);
  await ctx.close();
});

test("reduced motion: no card animations", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await createRoom(page, "Calm");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await expect(page.locator(".chain li").first()).toBeVisible();
  await expect(page.locator(".fx-card")).toHaveCount(0);
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await ctx.close();
});

test("keyboard: number keys play cards", async ({ page }) => {
  await createRoom(page, "Keys");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".card.playable").first()).toBeVisible();
  await page.locator("body").press("1");
  await expect(page.locator(".chain li").first()).toContainText("Client → Application");
});

test("phone: board, hand drawer and no sideways scroll @mobile", async ({ page }) => {
  await createRoom(page, "Mo");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  // the drawer opens by itself on my turn
  await expect(page.locator(".hand-panel")).not.toHaveClass(/collapsed/);
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  expect(await overflow()).toBeLessThanOrEqual(1);
  for (const role of ["client", "application", "idp", "mcp"]) {
    const box = await page.locator(`.terminal.r-${role}`).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
});

test("a card play stays on screen for about five seconds, showing expected vs played", async ({ page }) => {
  await createRoom(page, "Slow");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "Skip the Application"); // a mismatch
  const card = page.locator(".fx-card").first();
  await expect(card).toBeVisible();
  const shown = Date.now();
  await expect(card.locator(".fx-call").first()).toContainText("Send to the Application");
  await expect(card.locator(".fx-call").first()).toContainText("≠");
  await expect(card).toBeHidden({ timeout: 12_000 });
  const onScreen = Date.now() - shown;
  expect(onScreen).toBeGreaterThanOrEqual(4_800);
  expect(onScreen).toBeLessThan(8_000);

  // the same comparison is in the timeline and the result panel; a correct Reject is red = red
  const mcpReject = page.locator(".calls li:has(.calls-who.r-mcp)");
  await expect(mcpReject.locator(".call.match")).toBeVisible();
  await expect(mcpReject.locator(".chip.t-stop")).toHaveCount(2);
  await expect(mcpReject).toContainText("match");
  const mine = page.locator(".calls li:has(.calls-who.r-client)");
  await expect(mine.locator(".call.miss")).toContainText("mismatch");
  await expect(page.locator(".tl-msg.miss .call")).toContainText("Send to the Application");
});
