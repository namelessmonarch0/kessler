// Stub for Node.js-only built-ins that some npm packages reference from a dead code branch.
//
// satellite.js's compiled WASM runtime (node_modules/satellite.js/wasm-build/*-release/index.js,
// reached transitively via its `dist/index.js` barrel export, even though this app never calls
// satellite.js's WASM APIs) contains Emscripten's standard dual Node/browser bootstrap:
//
//   if (ENVIRONMENT_IS_NODE) {
//     const { createRequire } = await import("node:module");
//     var worker_threads = require("node:worker_threads");
//     ...
//   }
//
// `ENVIRONMENT_IS_NODE` is false in every browser/Worker context this app runs in, so that branch
// never executes — but `import("node:module")`/`require("node:worker_threads")` are literal string
// specifiers, so bundlers must still resolve them statically. Webpack fails fast with a clear
// "Reading from node:module is not handled" error; Turbopack (as of Next 16.3.6) instead hangs
// indefinitely when the reference is inside a `new Worker(..., { type: "module" })` entry point.
// See turbopack.resolveAlias in next.config.ts, and the fix report appended to
// .superpowers/sdd/2026-09-23-web-explorer/task-6-report.md for the full bisection.
export {};
