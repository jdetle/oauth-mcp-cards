import { expect, test } from "@playwright/test";
import { E2E_ADMIN_PASSWORD } from "../playwright.config";
import { createRoom, fillWithSims } from "./helpers";

test.skip(!!process.env.E2E_BASE_URL, "needs the local server's fixture admin password");

test("admin signs in, sees active games, deletes one; the players are told", async ({ page, browser }) => {
  const room = await createRoom(page, "Player");
  await fillWithSims(page);

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto("/admin/");
  await expect(admin.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();

  await admin.getByLabel("Admin password").fill("definitely-wrong");
  await admin.getByRole("button", { name: "Sign in" }).click();
  await expect(admin.locator(".error")).toHaveText("Wrong password.");

  await admin.getByLabel("Admin password").fill(E2E_ADMIN_PASSWORD);
  await admin.getByRole("button", { name: "Sign in" }).click();
  await expect(admin.getByRole("heading", { name: "Active games" })).toBeVisible();

  const row = admin.locator(`.admin-rooms li[data-room="${room}"]`);
  await expect(row).toContainText("Player");
  await expect(row.locator(".sim-tag")).toHaveCount(3);
  await expect(row).toContainText("1 connected");

  // delete asks first
  await row.getByRole("button", { name: `Delete ${room}` }).click();
  await expect(row).toContainText("Everyone at the table is disconnected");
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".board")).toBeVisible();

  await row.getByRole("button", { name: `Delete ${room}` }).click();
  await row.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(row).toHaveCount(0);

  // the player is told, and the room is gone from the lobby
  await expect(page.getByText("This game was closed by an admin.")).toBeVisible();
  await expect(page.locator(".board")).toHaveCount(0);
  await page.goto("/");
  await expect(page.locator(".room-item", { hasText: room })).toHaveCount(0);

  // sign out really signs out
  await admin.getByRole("button", { name: "Sign out" }).click();
  await expect(admin.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
  await ctx.close();
});

test("the admin page never shows games to someone who isn't signed in", async ({ page }) => {
  await createRoom(page, "Hidden");
  await page.context().clearCookies();
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
  await expect(page.locator(".admin-rooms")).toHaveCount(0);
});
