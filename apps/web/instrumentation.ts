// Runs once when the Next.js server starts (not during `next build`).
export async function register(): Promise<void> {
  // The check uses Node APIs, so it lives in its own module that only the Node
  // runtime ever loads.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./lib/assert-env");
    assertEnv();
  }
}
