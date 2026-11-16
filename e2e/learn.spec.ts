import { expect, test } from "@playwright/test";

test("explainer: paint, clock and signature labs work @smoke", async ({ page }) => {
  await page.goto("./learn/");
  await expect(page.getByRole("heading", { name: "Easy one way. Hard the other." })).toBeVisible();

  // paint: both sides always agree
  await page.getByLabel("Alice's secret colour").fill("120");
  await expect(page.locator(".lab").first().locator(".verdict")).toContainText("Both end with the same colour");
  const shared = await page.locator(".pot", { hasText: "shared" }).locator("span").evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  expect(shared[0]).toBe(shared[1]);

  // clock: 3^13 mod 17 = 12
  await page.getByLabel("Try x equals 4").click();
  await expect(page.getByText("1 try so far")).toBeVisible();
  await page.getByLabel("Try x equals 13").click();
  await expect(page.getByText(/Found it: x = 13, after 2 tries/)).toBeVisible();

  // signature: valid, then tampered, then forged
  const sig = page.locator("section", { hasText: "Sign it, check it" });
  await expect(sig.locator(".verdict")).toContainText("They match");
  await sig.getByLabel(/Tamper in transit/).check();
  await expect(sig.locator(".verdict")).toContainText("the message changed after it was signed");
  await sig.getByLabel(/Tamper in transit/).uncheck();
  await sig.getByLabel(/Forge it/).check();
  await expect(sig.locator(".verdict")).toContainText("wasn't made with the private key");
});

test("reference lists every auth method", async ({ page }) => {
  await page.goto("./reference/");
  for (const name of ["Non-OAuth", "MCP OAuth", "upstream credentials", "OAuth passthrough", "On-Behalf-Of", "ID-JAG", "AWS SigV4", "Zero Trust"]) {
    await expect(page.locator(".ref-table").getByText(name, { exact: false }).first()).toBeVisible();
  }
});

test("pages have no sideways scroll on a phone @mobile", async ({ page }) => {
  for (const path of ["./", "./learn/", "./reference/"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(1);
  }
});
