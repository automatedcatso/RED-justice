import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Never bundle SQLite databases into the standalone output — they are
  // runtime data, duplicated by output file tracing otherwise.
  //
  // v3.10.0: z-ai-web-dev-sdk is a DEV-ONLY tool (verification harness
  // bridge). Production builds must NOT ship or trace it — the dynamic
  // import in localAi.ts carries turbopackIgnore/webpackIgnore and resolves
  // at runtime only when an operator explicitly sets LOCAL_AI_BASE_URL=zai://glm
  // AND installed the package themselves. Explicit exclude keeps any stray
  // resolution from sneaking into the standalone output.
  outputFileTracingExcludes: {
    "*": ["**/prisma/db/**", "**/db/**", "**/node_modules/z-ai-web-dev-sdk/**"],
  },
};

export default nextConfig;
