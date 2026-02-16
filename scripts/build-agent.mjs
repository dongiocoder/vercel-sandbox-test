/**
 * Build the agent bundle into a single ESM file using esbuild.
 * The output is what gets written into each sandbox via writeFiles().
 */
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(projectRoot, "src/agent-bundle/server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: path.join(projectRoot, "dist/agent-server.mjs"),
  // The SDK is pre-installed in the sandbox (via snapshot or npm install)
  external: [
    "@anthropic-ai/claude-agent-sdk",
    "@hono/node-server",
    "hono",
    "hono/*",
    "uuid",
    "dotenv",
    "dotenv/*",
  ],
  banner: {
    js: "// Auto-generated agent bundle — do not edit\n",
  },
});

console.log("Agent bundle built: dist/agent-server.mjs");
