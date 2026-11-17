import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoom, fillWithSims, jumpTo, playCard, result } from "./helpers";

// A deploy replaces the server under a live game. The game must carry on: same room, same
// seat, same round, same cards, without anyone signing in again. This runs its own server,
// stops it the way ECS does (SIGTERM), and starts a fresh one on the same port.

const PORT = 8097;
const dir = mkdtempSync(join(tmpdir(), "omcp-rooms-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  STATIC_DIR: "../out",
  GAMES_DIR: "../games",
  INTERNAL_TOKEN: "playwright-internal-token-0123456789",
  SIM_SKILL: "1",
  SIM_DELAY_MS: "150",
  READY_TIMEOUT_MS: "20000",
  ROOMS_DIR: dir,
  SESSION_SECRET: "a".repeat(64),
  BASE_PATH: "",
};

function start(): Promise<ChildProcess> {
  const p = spawn("./target/release/oauth-mcp-server", [], { cwd: "server", env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let log = "";
    const on = (b: Buffer) => {
      log += b.toString();
      if (log.includes("listening on")) resolve(p);
    };
    p.stdout!.on("data", on);
    p.stderr!.on("data", on);
    p.on("exit", (c) => reject(new Error(`server exited ${c}: ${log}`)));
  });
}

const stopped = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.on("exit", () => r())));

test.use({ baseURL: `http://localhost:${PORT}/` });
test.skip(!!process.env.E2E_BASE_URL || !!process.env.E2E_BASE_PATH, "runs its own local server");

test("a game survives the server being replaced mid-round", async ({ page }) => {
  test.setTimeout(90_000);
  let server = await start();
  try {
    await createRoom(page, "Ada", "Application");
    await fillWithSims(page);
    await jumpTo(page, "Learning: On-Behalf-Of");
    // the Client (a sim) has moved; it's my turn with a slip on the wire
    await expect(page.locator(".card.playable").first()).toBeVisible({ timeout: 15_000 });
    const round = await page.locator(".hud-label").textContent();
    const wire = await page.locator(".wire").textContent();

    // deploy: the old server saves, tells the browser to reconnect, and stops
    server.kill("SIGTERM");
    await stopped(server);
    await expect(page.locator(".conn.off")).toBeVisible();
    server = await start();

    // the browser reconnects to the new server, still signed in, at the same point
    await expect(page.locator(".conn.off")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".hud-label")).toHaveText(round!);
    await expect(page.locator(".wire")).toHaveText(wire!);
    await expect(page.locator(".card.playable").first()).toBeVisible();

    // and play carries on to the end of the round
    await playCard(page, /Exchange card/);
    await expect(result(page)).toContainText("Chain unbroken", { timeout: 20_000 });
  } finally {
    server.kill("SIGTERM");
    await stopped(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
