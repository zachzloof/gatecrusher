import { describe, expect, it } from "vitest";
import { freePort } from "./ports.ts";
import { postgresCommands, type PostgresOptions } from "./postgres.ts";

const options: PostgresOptions = {
  installDir: "/app/postgres",
  dataDir: "/data/postgres",
  logFile: "/data/logs/postgres.log",
  password: "f".repeat(64),
  port: 54_321,
  platform: "darwin",
};

describe("postgresCommands", () => {
  const commands = postgresCommands(options, "/data/.pgpass-1");

  it("creates the cluster with a password, never trust auth, and never puts it on a command line", () => {
    expect(commands.initdb).toContain("--auth=scram-sha-256");
    expect(commands.initdb).toContain("--pwfile=/data/.pgpass-1");
    expect(commands.initdb.join(" ")).not.toContain(options.password);
  });

  it("listens on loopback TCP only, on the chosen port", () => {
    const serverOptions = commands.start[commands.start.indexOf("-o") + 1];

    expect(serverOptions).toBe(
      "-p 54321 -c listen_addresses=127.0.0.1 -c unix_socket_directories=",
    );
    expect(commands.start).toEqual(expect.arrayContaining(["-w", "-l", options.logFile]));
  });

  it("stops quickly and waits until it has", () => {
    expect(commands.stop).toEqual(["stop", "-D", "/data/postgres", "-m", "fast", "-w", "-t", "30"]);
  });
});

describe("freePort", () => {
  it("returns the preferred port when it is free, another one when it is taken", async () => {
    const taken = await freePort();
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(taken, "127.0.0.1", resolve));
    try {
      const other = await freePort(taken);
      expect(other).not.toBe(taken);
      expect(other).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await freePort(taken)).toBe(taken);
  });
});
