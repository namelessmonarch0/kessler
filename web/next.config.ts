import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    resolveAlias: {
      "#wasm-single-thread": "./src/lib/emptyNodeModule.ts",
      "#wasm-multi-thread": "./src/lib/emptyNodeModule.ts",
    },
  },
};

export default nextConfig;
