import { expect, type Page } from "@playwright/test";

export const PASSWORD = "table-pw";

/** Create a room through the lobby UI and land on the table. Returns the room name. */
export async function createRoom(page: Page, name = "Tester", seat: string = "Client"): Promise<string> {
  await page.goto("/");
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
