import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` is used, which diffs the schema against the committed
// migrations and needs no database connection. Migrations are applied by
// `pnpm db:migrate` (src/cli/migrate.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
