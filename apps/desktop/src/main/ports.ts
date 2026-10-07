import { createServer } from "node:net";

function listen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const chosen = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => resolve(chosen));
    });
  });
}

/**
 * A free port on 127.0.0.1: `preferred` when it is free, so the app keeps the same
 * address (and the browser storage tied to it) between starts; any free one otherwise.
 */
export async function freePort(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    const port = await listen(preferred);
    if (port !== null) return port;
  }
  const port = await listen(0);
  if (port === null) throw new Error("No free port on 127.0.0.1");
  return port;
}
