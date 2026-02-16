/**
 * Create a base snapshot with all agent dependencies pre-installed.
 * Run this once before first use: npx tsx scripts/create-snapshot.ts
 *
 * The snapshot ID is saved to .snapshot-id and used by the orchestrator.
 * Snapshots expire after 7 days — re-run weekly.
 */
import { Sandbox } from "@vercel/sandbox";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const SNAPSHOT_FILE = path.join(process.cwd(), ".snapshot-id");

async function main() {
  console.log("Creating base snapshot for agent sandbox...\n");

  // 1. Create a bare sandbox
  console.log("[1/5] Creating bare sandbox (node22)...");
  const startCreate = Date.now();
  const sandbox = await Sandbox.create({
    runtime: "node22",
    timeout: 10 * 60 * 1000, // 10 minutes for snapshot creation
  });
  console.log(`  Created in ${Date.now() - startCreate}ms\n`);

  try {
    // 2. Write package.json with agent dependencies
    console.log("[2/5] Writing package.json...");
    await sandbox.writeFiles([
      {
        path: "package.json",
        content: Buffer.from(
          JSON.stringify(
            {
              name: "sandbox-agent",
              type: "module",
              dependencies: {
                "@anthropic-ai/claude-agent-sdk": "^0.1.56",
                "@anthropic-ai/sdk": "^0.71.2",
                "@hono/node-server": "^1.13.7",
                hono: "^4.6.0",
                dotenv: "^17.2.3",
                uuid: "^13.0.0",
              },
            },
            null,
            2
          ),
          "utf-8"
        ),
      },
    ]);
    console.log("  Done\n");

    // 3. Install dependencies
    console.log("[3/5] Running npm install...");
    const startInstall = Date.now();
    const installResult = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--production"],
      env: { NODE_ENV: "production" },
    });
    console.log(
      `  npm install completed in ${Date.now() - startInstall}ms (exit: ${installResult.exitCode})`
    );
    if (installResult.exitCode !== 0) {
      const stderr = await installResult.stderr();
      console.error("  npm install stderr:", stderr);
      throw new Error("npm install failed");
    }
    console.log();

    // 4. Install Claude Code CLI globally
    console.log("[4/5] Installing @anthropic-ai/claude-code globally...");
    const startGlobal = Date.now();
    const globalResult = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
    });
    console.log(
      `  Global install completed in ${Date.now() - startGlobal}ms (exit: ${globalResult.exitCode})`
    );
    if (globalResult.exitCode !== 0) {
      const stderr = await globalResult.stderr();
      console.error("  Global install stderr:", stderr);
      // Non-fatal — the bundled CLI in node_modules should work
      console.log(
        "  Warning: global install failed, bundled CLI will be used"
      );
    }
    console.log();

    // 5. Create snapshot (this stops the sandbox automatically)
    console.log("[5/5] Creating snapshot...");
    const startSnapshot = Date.now();
    const snapshot = await sandbox.snapshot();
    console.log(`  Snapshot created in ${Date.now() - startSnapshot}ms`);
    console.log(`  ID: ${snapshot.snapshotId}`);

    // Save snapshot ID to file
    fs.writeFileSync(SNAPSHOT_FILE, snapshot.snapshotId, "utf-8");
    console.log(`\nSnapshot ID saved to ${SNAPSHOT_FILE}`);
    console.log(
      "Note: Snapshots expire after 7 days. Re-run this script weekly."
    );
  } catch (error) {
    // If snapshot wasn't created, stop the sandbox manually
    try {
      await sandbox.stop();
    } catch {
      // ignore
    }
    throw error;
  }
}

main().catch((err) => {
  console.error("\nSnapshot creation failed:", err);
  process.exit(1);
});
