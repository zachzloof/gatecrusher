import { describe, expect, it } from "vitest";
import { homeDestination } from "./home-destination";

const silentLog = { error: () => undefined };

describe("homeDestination", () => {
  it("greets with the connect screen while no SoundCloud account is connected", async () => {
    expect(await homeDestination(() => Promise.resolve(null), silentLog)).toBe("/connect");
  });

  it("goes to the playlists once one is connected", async () => {
    const account = { username: "burner-digger" };

    expect(await homeDestination(() => Promise.resolve(account), silentLog)).toBe("/playlists");
  });

  it("goes to the playlists, and logs why, when the database cannot be asked", async () => {
    const logged: string[] = [];

    const destination = await homeDestination(() => Promise.reject(new Error("ECONNREFUSED")), {
      error: (_fields, message) => void logged.push(message),
    });

    expect(destination).toBe("/playlists");
    expect(logged).toHaveLength(1);
  });
});
