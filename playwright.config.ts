import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

// Browser tests drive the real UI against the real Rust server.
// Sims are set to perfect, fast play so outcomes are deterministic.
const PORT = Number(process.env.E2E_PORT ?? 8091);
const TOKEN = "playwright-internal-token-0123456789";
const external = process.env.E2E_BASE_URL; // e.g. the deployed site (smoke run)
// E2E_BASE_PATH=/mcp-oauth runs the suite with the app mounted under a prefix.
// The front end must have been built with the same NEXT_PUBLIC_BASE_PATH.
const BASE_PATH = (process.env.E2E_BASE_PATH ?? "").replace(/\/$/, "");
// the admin password used by e2e/admin.spec.ts, hashed by the server binary itself
export const E2E_ADMIN_PASSWORD = "fixture-admin-password";
const adminHash = external ? "" : execFileSync("./server/target/release/oauth-mcp-server", ["hash-password"], { input: `${E2E_ADMIN_PASSWORD}\n` }).toString().trim();

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: external ?? `http://localhost:${PORT}${BASE_PATH}/`,
    // lets the test run skip the per-IP room-creation limit (ignored by a server without the token)
    extraHTTPHeaders: { "x-omcp-internal": TOKEN },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile|@smoke/ },
  ],
  webServer: external
    ? undefined
    : {
        command: "./target/release/oauth-mcp-server",
        cwd: "server",
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: false,
        env: { PORT: String(PORT), STATIC_DIR: "../out", SCENARIOS_DIR: "../scenarios", INTERNAL_TOKEN: TOKEN, SIM_SKILL: "1", SIM_DELAY_MS: "150", READY_TIMEOUT_MS: "20000", ADMIN_PASSWORD_HASH: adminHash, BASE_PATH },
      },
});
