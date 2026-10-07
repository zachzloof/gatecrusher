import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests talk to the development Postgres, so pick up the root .env when
// there is one and fall back to the Compose defaults.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env.DATABASE_URL ??= "postgres://gatecrusher:gatecrusher@localhost:5432/gatecrusher";
process.env.LOG_LEVEL = "silent";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["app/**/*.test.ts", "lib/**/*.test.ts", "components/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
