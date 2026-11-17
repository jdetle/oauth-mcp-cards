import { expect, type Page } from "@playwright/test";

export const PASSWORD = "table-pw";

/** A played card that has landed and is waiting to be clicked. */
export const unread = (page: Page) => page.locator(".fx-card.landed").first();

/**
 * A played card stays on the table until it is clicked. Most tests are about something else,
 * so they read each card the moment it gets in the way. `page.removeLocatorHandler(unread(page))`
 * turns this off for a test about the cards themselves.
 */
export async function readCards(page: Page) {
  await page.addLocatorHandler(unread(page), async (card) => {
    // a plain click event: a real click would scroll the card into view and move the page
    await card.dispatchEvent("click").catch(() => {});
  }, { noWaitAfter: true });
}

/** Create a room through the lobby UI and land on the table. Returns the room name. */
export async function createRoom(page: Page, name = "Tester", seat: string = "Client", game?: string): Promise<string> {
  await readCards(page);
  await page.goto("./");
  if (game) {
    // another game in the series: pick it first (its seats have their own names)
    await page.getByRole("radio", { name: new RegExp(game) }).click();
    await expect(page.locator("#create-h")).toContainText(game);
  }
  const form = page.getByRole("form", { name: "Create a room" });
  await form.getByLabel("Display name").fill(name);
  await form.getByLabel("Set a room password").fill(PASSWORD);
  await form.getByLabel("Seat").selectOption({ label: seat });
  await form.getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/play\/\?room=/);
  const room = new URL(page.url()).searchParams.get("room")!;
  expect(room).toMatch(/^[a-z]+-[a-z]+(-\d{1,3})?$/);
  await expect(page.locator(".hud-room b")).toHaveText(room);
  return room;
}

export async function fillWithSims(page: Page) {
  await page.getByRole("button", { name: /Fill \d empty seats? with sims/ }).click();
  await expect(page.locator(".terminal .sim-tag")).toHaveCount(3);
}

/** Host: jump to a round by its label in the picker. */
export async function jumpTo(page: Page, label: RegExp | string) {
  const select = page.getByLabel("Jump to round");
  const option = select.locator("option", { hasText: label }).first();
  await select.selectOption(await option.getAttribute("value") as string);
  await page.getByRole("button", { name: "Jump", exact: true }).click();
}

/** Play the card in your hand whose label contains `text` (waits for your turn). */
export async function playCard(page: Page, text: string | RegExp) {
  const card = page.locator(".card.playable", { hasText: text }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
}

export const result = (page: Page) => page.locator(".result");
