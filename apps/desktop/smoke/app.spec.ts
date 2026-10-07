import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import electronPath from "electron";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gatecrusher-smoke-"));
});

test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function launch(): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Set when this runs inside an Electron-based editor; it would start Electron as Node.
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  return electron.launch({
    // From Node, the electron package exports the binary's path; its types describe the
    // Electron API instead.
    executablePath: electronPath as unknown as string,
    args: [DESKTOP],
    env: { ...env, GATECRUSHER_ROOT: root },
  });
}

async function health(url: string) {
  const response = await fetch(new URL("/api/health", url));
  return (await response.json()) as { db: { ok: boolean }; worker: { online: boolean } };
}

test("first start asks for the code, then runs the app on its own database", async () => {
  const app = await launch();
  const gate = await app.firstWindow();

  await expect(gate.getByRole("heading", { name: "Enter your access code" })).toBeVisible();
  await gate.getByLabel("Access code").fill("let me in");
  await gate.getByRole("button", { name: "Continue" }).click();
  await expect(gate.getByRole("alert")).toContainText("That code is not right");

  const mainWindow = app.waitForEvent("window", { timeout: 120_000 });
  await gate.getByLabel("Access code").fill("  GateCrusher ");
  await gate.getByRole("button", { name: "Continue" }).click();

  const page = await mainWindow;
  await page.waitForURL(/127\.0\.0\.1:\d+\/connect/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Connect SoundCloud" })).toBeVisible();

  const url = new URL(page.url()).origin;
  await expect.poll(async () => (await health(url)).db.ok).toBe(true);
  await expect.poll(async () => (await health(url)).worker.online, { timeout: 60_000 }).toBe(true);
  await expect(page.getByText("docker compose")).toHaveCount(0);

  await app.close();
  // Quitting stops the private Postgres.
  await expect
    .poll(() => existsSync(path.join(root, "postgres", "postmaster.pid")), { timeout: 30_000 })
    .toBe(false);
});

test("a second start goes straight to the app", async () => {
  const app = await launch();
  const windows: string[] = [];
  app.on("window", (window) => windows.push(window.url()));

  const page = await app.waitForEvent("window", {
    predicate: (window) => window.url().startsWith("http://127.0.0.1"),
    timeout: 120_000,
  });
  await expect(page.getByRole("heading", { name: "Connect SoundCloud" })).toBeVisible({
    timeout: 60_000,
  });
  const gate = app.windows().find((window) => window.url().endsWith("gate.html"));
  if (gate !== undefined && !gate.isClosed()) {
    await expect(gate.getByRole("heading", { name: "Enter your access code" })).toBeHidden();
  }

  await app.close();
});
