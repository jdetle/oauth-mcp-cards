import { defineConfig, devices } from "@playwright/test";

// Browser tests drive the real UI against the real Rust server.
// Sims are set to perfect, fast play so outcomes are deterministic.
const PORT = Number(process.env.E2E_PORT ?? 8091);
const TOKEN = "playwright-internal-token-0123456789";
const external = process.env.E2E_BASE_URL; // e.g. the deployed site (smoke run)

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: external ?? `http://localhost:${PORT}`,
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
        env: { PORT: String(PORT), STATIC_DIR: "../out", SCENARIOS_DIR: "../scenarios", INTERNAL_TOKEN: TOKEN, SIM_SKILL: "1", SIM_DELAY_MS: "150" },
      },
});
