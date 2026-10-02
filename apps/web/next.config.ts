import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Next always runs with apps/web as the working directory.
const repoRoot = path.resolve(process.cwd(), "../..");

// One .env at the repo root serves web, worker and Compose. Next only looks in
// apps/web, so load the root file here. Variables already set in the real
// environment (e.g. by Docker Compose) win.
const rootEnv = path.join(repoRoot, ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@gatecrusher/core", "@gatecrusher/db"],
  outputFileTracingRoot: repoRoot,
  // Standalone output is only built for the Docker image (see apps/web/Dockerfile).
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  // The dev-mode indicator sits bottom-left, on top of the mobile bottom nav.
  devIndicators: false,
};

export default nextConfig;
