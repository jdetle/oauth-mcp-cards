import { devices, expect, test, type Page } from "@playwright/test";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

test.use({ ...devices["iPhone 15 Pro"], browserName: "webkit" });
test.skip(!process.env.REVIEW, "REVIEW=1 to capture");

const dir = "e2e/screenshots/review";
async function audit(page: Page, name: string) {
  await page.screenshot({ path: `${dir}/${name}.png` });
  const facts = await page.evaluate(() => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.top < innerHeight;
    };
    const small = [...document.querySelectorAll("button, a, input, select, [role=tab], [role=radio]")]
      .filter(vis)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height < 44 || r.width < 44)
      .map(({ el, r }) => `${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").trim().slice(0, 28)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    const tiny = new Map<string, number>();
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el) || !(el as HTMLElement).innerText?.trim() || el.children.length > 0) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) tiny.set(`${px}px`, (tiny.get(`${px}px`) ?? 0) + 1);
    }
    const fixed = [...document.querySelectorAll("body *")].filter((el) => ["fixed", "sticky"].includes(getComputedStyle(el).position) && vis(el)).map((el) => {
      const r = el.getBoundingClientRect();
      return `${el.className.toString().split(" ")[0]} covers ${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight}`;
    });
    return { small: small.slice(0, 14), smallCount: small.length, tiny: Object.fromEntries(tiny), fixed, scroll: `${document.documentElement.scrollHeight}px tall` };
  });
  console.log(`=== ${name}\n${JSON.stringify(facts, null, 1)}`);
}

test("capture the iPhone journey @mobile", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.goto("./");
  await page.waitForTimeout(500);
  await audit(page, "01-lobby");
  await page.locator("form[aria-label='Create a room']").scrollIntoViewIfNeeded();
  await audit(page, "02-create-form");

  await createRoom(page, "Ada", "Application");
  await page.evaluate(() => scrollTo(0, 0));
  await audit(page, "03-table-waiting-top");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await audit(page, "04-my-turn-followed");
  await page.locator(".hand-panel").screenshot({ path: `${dir}/05-hand-drawer.png` });
  await playCard(page, "Forward the token");
  await expect(result(page)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(6500);
  await audit(page, "06-result-followed");
  await page.locator(".ready-bar").screenshot({ path: `${dir}/07-ready-bar.png` });
  await page.locator(".side").scrollIntoViewIfNeeded();
  await audit(page, "08-side-timeline");
  await page.locator(".ready-bar").getByRole("button", { name: "I'm ready" }).click();
  await jumpTo(page, "Assessment 1");
  await page.waitForTimeout(1200);
  await audit(page, "09-assessment-identify");

  const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
  const p2 = await ctx.newPage();
  for (const [path, name] of [["./learn/", "10-learn"], ["./reference/", "11-reference"], ["./admin/", "12-admin"]] as const) {
    await p2.goto(path);
    await p2.waitForTimeout(600);
    await audit(p2, name);
  }
  await ctx.close();
});
