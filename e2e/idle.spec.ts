import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoom, fillWithSims, jumpTo, PASSWORD, playCard, result } from "./helpers";

// Taking it slow: a table created with its timers off never moves on by itself. A table nobody
// touches is still saved and closed (five minutes in production; three seconds here), and
// resumes exactly where it was. Runs its own server so the idle limit can be short.

const PORT = 8098;
const dir = mkdtempSync(join(tmpdir(), "omcp-idle-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  STATIC_DIR: "../out",
  GAMES_DIR: "../games",
  INTERNAL_TOKEN: "playwright-internal-token-0123456789",
  SIM_SKILL: "1",
  SIM_DELAY_MS: "150",
  READY_TIMEOUT_MS: "2000",
  ROOM_IDLE_SECS: "6",
  ROOMS_DIR: dir,
  SESSION_SECRET: "b".repeat(64),
  BASE_PATH: "",
};

function start(): Promise<ChildProcess> {
  const p = spawn("./target/release/oauth-mcp-server", [], { cwd: "server", env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let log = "";
    const on = (b: Buffer) => {
      if (process.env.IDLE_LOG) appendFileSync(process.env.IDLE_LOG, b);
      log += b.toString();
      if (log.includes("listening on")) resolve(p);
    };
    p.stdout!.on("data", on);
    p.stderr!.on("data", on);
    p.on("exit", (c) => reject(new Error(`server exited ${c}: ${log}`)));
  });
}

test.use({ baseURL: `http://localhost:${PORT}/` });
test.skip(!!process.env.E2E_BASE_URL || !!process.env.E2E_BASE_PATH, "runs its own local server");

let server: ChildProcess;
test.beforeAll(async () => {
  server = await start();
});
test.afterAll(async () => {
  // wait for it to go, so the port is free for the next run
  const gone = new Promise<void>((r) => (server.exitCode !== null ? r() : server.on("exit", () => r())));
  server.kill("SIGTERM");
  await gone;
  rmSync(dir, { recursive: true, force: true });
});

test("no timers: the round waits for a ready click; an idle table is saved, closed and resumes", async ({ page }) => {
  test.setTimeout(90_000);
  // create a room with the timers off
  await page.goto("./");
  const form = page.getByRole("form", { name: "Create a room" });
  await form.getByLabel("Display name").fill("Slow");
  await form.getByLabel("Set a room password").fill(PASSWORD);
  await form.getByLabel("Seat").selectOption({ label: "Client" });
  await form.getByLabel(/No timers/).check();
  await form.getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/play\/\?room=/);
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });

  // the ready check has no countdown, and outlasts the (2s) timer this server would otherwise run
  const bar = page.locator(".ready-bar");
  await expect(bar).toContainText("No timer");
  await expect(bar.locator(".ready-timer")).toHaveCount(0);
  await page.waitForTimeout(3_500);
  await expect(page.locator(".hud-label")).toContainText("Learning 4/28");
  await expect(bar.getByRole("button", { name: "I'm ready" })).toBeVisible();

  // nobody touches it: saved and closed, with a way back
  await expect(page.getByText("Nobody did anything for five minutes")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Resume the game" }).click();
  await expect(page.locator(".hud-label")).toContainText("Learning 4/28");
  await expect(result(page)).toContainText("Chain unbroken");
  await expect(page.locator(".ready-bar")).toContainText("No timer");
});

test("timers on: the same server moves an idle table on by itself", async ({ page }) => {
  await createRoom(page, "Quick");
  await fillWithSims(page);
  await jumpTo(page, "Learning: On-Behalf-Of");
  await playCard(page, "with the user's token slip");
  await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  await expect(page.locator(".ready-bar .ready-timer")).toBeVisible();
  await expect(page.locator(".hud-label")).toContainText("Learning 5/28", { timeout: 10_000 });
});
