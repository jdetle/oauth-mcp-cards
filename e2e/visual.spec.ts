// Captures the key screens for a human design review: `VISUAL=1 bunx playwright test visual`.
// Not assertions; images land in e2e/screenshots/.
import { test } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

test.skip(!process.env.VISUAL, "set VISUAL=1 to capture review screenshots");

test("capture screens @mobile", async ({ page }, info) => {
  const shot = (name: string, fullPage = false) => page.screenshot({ path: `e2e/screenshots/${info.project.name}-${name}.png`, fullPage });
  await page.goto("./");
  await page.waitForTimeout(600);
  await shot("1-lobby");

  await createRoom(page, "Ada", "Identity Provider");
  await fillWithSims(page);
  await shot("2-table-ready");

  await jumpTo(page, "Learning: JWT Authorization Grant");
  await page.locator(".wire .slip", { hasText: "signed assertion" }).waitFor();
  await page.waitForTimeout(1800); // let the arriving card resolve
  await shot("3-signed-assertion-my-turn");

  await playCard(page, "Reject"); // wrong on purpose: the assertion is valid
  await result(page).waitFor();
  await page.waitForTimeout(2200);
  await shot("4-chain-broken", true);

  await jumpTo(page, "Assessment 1");
  await page.getByRole("radiogroup").waitFor();
  await shot("5-assessment-identify", true);

  await page.goto("./learn/");
  await page.waitForTimeout(500);
  await shot("6-learn", true);
});
