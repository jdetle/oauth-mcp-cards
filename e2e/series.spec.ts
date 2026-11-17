import { expect, test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// The series: the same table plays every game. These run a scripted game (Agent Security)
// through the things only scripted games have: named seats, a slip of labelled fields,
// sealed values revealed by a free check, and a question answered in secret.

test("series home lists the games; each has a primer @mobile", async ({ page }) => {
  await page.goto("./");
  const games = page.getByRole("radio");
  await expect(games.filter({ hasText: "OAuth for MCP" })).toHaveAttribute("aria-checked", "true");
  await expect(games.filter({ hasText: "Agent Security" })).toBeVisible();
  await games.filter({ hasText: "Agent Security" }).click();
  await expect(page.locator(".seat-list li")).toHaveCount(4);
  await expect(page.locator(".seat-list")).toContainText("Orchestrator");
  // the create form now offers that game's seats
  const seat = page.getByRole("form", { name: "Create a room" }).getByLabel("Seat");
  await expect(seat.locator("option")).toContainText(["Any open seat", "User", "Orchestrator", "Sub-agent", "Tool", "Just watch (spectator)"]);
  await page.getByRole("link", { name: /What Agent Security teaches/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agent Security");
  await expect(page.locator(".glossary")).toContainText("Confused deputy");
});

test("a scripted game: check a sealed field, make the call, the chain holds @mobile @smoke", async ({ page }) => {
  await createRoom(page, "Tia", "Tool", "Agent Security");
  await expect(page.locator(".role-chip")).toHaveText("Tool");
  await fillWithSims(page);
  await jumpTo(page, "Whose Words Are These?");

  // sims play User, Orchestrator and Sub-agent; then the booking call reaches the Tool
  await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 20_000 });
  const wire = page.locator(".wire");
  await expect(wire).toContainText("Sub-agent → Tool");
  await expect(wire).toContainText("Tool call");
  const sealed = wire.locator(".slip .field-sealed");
  await expect(sealed).toHaveCount(1); // "on behalf of" is hidden; action and limit are plain
  expect(await page.content()).not.toContain("via the travel sub-agent"); // the value isn't on the page at all

  // the check is an "ought to do" card: free, and it shows the value to everyone
  // optional cards: the one check, plus two that only look helpful (nothing marks which is which)
  await expect(page.locator(".hand-group.ought .card")).toHaveCount(3);
  await expect(page.locator(".hand-group.ought .card .cat")).toContainText(["optional", "optional", "optional"]);
  await playCard(page, "Check who this call is for");
  await expect(wire.locator(".field-ok")).toContainText("user:alex, via the travel sub-agent");
  await expect(sealed).toHaveCount(0);

  await playCard(page, "Run it: book the ticket");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(result(page)).toContainText("Each hop knew who was speaking");
  await expect(result(page).locator(".calls li").last()).toContainText("Tool");
  await expect(result(page)).toContainText("Verified before trusting");
});

test("a scripted game: a wrong call breaks the chain and says why", async ({ page }) => {
  await createRoom(page, "Otto", "Orchestrator", "Agent Security");
  await fillWithSims(page);
  await jumpTo(page, "The Confused Deputy");
  await playCard(page, "with the service account");
  await expect(result(page)).toContainText("Chain broken at Orchestrator", { timeout: 20_000 });
  await expect(result(page)).toContainText("That is the confused deputy");
  await expect(result(page)).toContainText("played a trap");
});

test("a scripted game: the question is answered in secret, then scored", async ({ page }) => {
  await createRoom(page, "Sam", "Sub-agent", "Agent Security");
  await fillWithSims(page);
  await jumpTo(page, "Assessment 1");
  await expect(page.getByRole("heading", { name: /what is the main risk/ })).toBeVisible();
  // (click, not check: the panel goes away the moment the last answer is in)
  await page.getByLabel("Something the assistant reads tries to give it instructions").click();
  // the sims answer too, then play starts and the Sub-agent goes first
  await playCard(page, "report the P.S. as untrusted");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(result(page)).toContainText("The question:");
  await expect(result(page)).toContainText("✓ Sam: Something the assistant reads");
  await expect(result(page)).toContainText("Answered the question");
});

test("not every optional card is a good idea: a tempting one breaks the chain @mobile", async ({ page }) => {
  await createRoom(page, "Tia", "Tool", "Agent Security");
  await fillWithSims(page);
  await jumpTo(page, "Whose Words Are These?");
  await playCard(page, "Run it twice in case the first one fails");
  await expect(result(page)).toContainText("Chain broken at Tool", { timeout: 20_000 });
  await expect(result(page)).toContainText("Two bookings is two tickets and two charges");
  await expect(result(page)).toContainText("played a trap");
  await expect(result(page).locator(".calls li").last()).toContainText("Leave it alone");
});

test("OAuth game: the MCP Server is offered optional cards that are mistakes", async ({ page }) => {
  await createRoom(page, "Mo", "MCP Server");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  // five checks and two temptations, mixed together
  const optional = page.locator(".hand-group.ought .card");
  await expect(optional.first()).toBeVisible({ timeout: 20_000 });
  await expect(optional).toHaveCount(7);
  const bait = optional.filter({ hasText: /Log the full token|X-User header|reuse for the next caller|inside the network/ });
  await expect(bait).toHaveCount(2);
  await bait.first().click();
  await expect(result(page)).toContainText("Chain broken at MCP Server", { timeout: 20_000 });
  await expect(result(page)).toContainText("played a trap");
});

// Every game in the series, end to end in the browser: host as a spectator, four sims at the
// table, one learning round played through. Proves each pack loads, deals, plays and ends.
const GAMES: [title: string, round: string, seats: string[]][] = [
  ["Agent Security", "Whose Words Are These?", ["User", "Orchestrator", "Sub-agent", "Tool"]],
  ["Supply Chain", "Who Built This?", ["Developer", "Build System", "Registry", "Deployer"]],
  ["Workload Identity", "Prove What You Are", ["Caller", "Mesh Proxy", "Issuer", "Service"]],
  ["Passkeys", "The Look-Alike", ["User", "Browser", "Authenticator", "Website"]],
  ["Consensus", "The Leader Who Came Back", ["Client", "Leader", "Follower A", "Follower B"]],
  ["Zero-Knowledge", "Commit First", ["Prover", "Verifier", "Issuer", "Service"]],
];

test("the series home offers all seven games", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("radio")).toHaveCount(7);
  await expect(page.getByRole("radio")).toContainText(["OAuth for MCP", ...GAMES.map((g) => g[0])]);
});

for (const [title, round, seats] of GAMES) {
  test(`${title}: sims play a learning round to the end`, async ({ page }) => {
    await createRoom(page, "Host", "Just watch (spectator)", title);
    await page.getByRole("button", { name: "Fill 4 empty seats with sims" }).click();
    await expect(page.locator(".terminal .sim-tag")).toHaveCount(4);

    await jumpTo(page, round);
    // the four seats carry this game's names
    for (const s of seats) await expect(page.locator(".terminal .t-role", { hasText: new RegExp(`^${s}$`) })).toHaveCount(1);
    await expect(page.locator(".scenario h2")).toContainText(round);
    await expect(result(page)).toContainText("Chain unbroken", { timeout: 30_000 });
    // the result names seats by their game names and lists what the round teaches
    await expect(result(page).locator(".calls li").first()).toBeVisible();
    await expect(result(page)).toContainText("What this round teaches");
    await expect(page.locator(".hud-game")).toHaveText(title);
  });
}
