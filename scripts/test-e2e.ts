/**
 * End-to-end smoke test for the orchestrator.
 *
 * Usage: npx tsx scripts/test-e2e.ts
 *
 * Prerequisites:
 *   1. Run `npm run build:agent` to build the agent bundle
 *   2. Run `npx tsx scripts/create-snapshot.ts` (optional but faster)
 *   3. Start orchestrator: `npm run dev`
 *   4. In another terminal: `npx tsx scripts/test-e2e.ts`
 */
import "dotenv/config";

const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL || "http://localhost:4000";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  details?: string;
  error?: string;
}

async function testHealth(): Promise<TestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/health`);
    const body = await res.json();

    if (res.ok && body.status === "healthy") {
      return {
        name: "Health check",
        passed: true,
        duration: Date.now() - start,
        details: `Agents available: ${(body.agents as string[]).join(", ")}`,
      };
    }
    return {
      name: "Health check",
      passed: false,
      duration: Date.now() - start,
      error: `Unexpected response: ${JSON.stringify(body)}`,
    };
  } catch (error) {
    return {
      name: "Health check",
      passed: false,
      duration: Date.now() - start,
      error: `Could not reach orchestrator at ${ORCHESTRATOR_URL}. Is it running?`,
    };
  }
}

async function testProcess(): Promise<TestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "How do I reset my password?",
        agentId: "sample",
      }),
    });

    const duration = Date.now() - start;
    const body = await res.json();

    if (res.ok && body.response) {
      return {
        name: "POST /process",
        passed: true,
        duration,
        details: [
          `Response length: ${(body.response as string).length} chars`,
          `Confidence: ${body.confidence || "N/A"}`,
          `Timing: create=${body.timing?.sandboxCreate}ms write=${body.timing?.fileWrite}ms health=${body.timing?.healthPoll}ms agent=${body.timing?.agentProcess}ms total=${body.timing?.total}ms`,
        ].join("\n    "),
      };
    }

    return {
      name: "POST /process",
      passed: false,
      duration,
      error: body.error || JSON.stringify(body),
    };
  } catch (error) {
    return {
      name: "POST /process",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testValidation(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Missing agentId
    const res = await fetch(`${ORCHESTRATOR_URL}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    const duration = Date.now() - start;
    const body = await res.json();

    if (res.status === 400 && body.error) {
      return {
        name: "Validation (missing agentId)",
        passed: true,
        duration,
        details: `Got expected 400: ${body.error}`,
      };
    }

    return {
      name: "Validation (missing agentId)",
      passed: false,
      duration,
      error: `Expected 400, got ${res.status}`,
    };
  } catch (error) {
    return {
      name: "Validation (missing agentId)",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log("=== Vercel Sandbox Test — E2E Smoke Test ===\n");
  console.log(`Target: ${ORCHESTRATOR_URL}\n`);

  const results: TestResult[] = [];

  // Run tests sequentially
  results.push(await testHealth());
  if (!results[0].passed) {
    console.log("Health check failed — skipping remaining tests.\n");
    printResults(results);
    process.exit(1);
  }

  results.push(await testValidation());
  results.push(await testProcess());

  printResults(results);

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

function printResults(results: TestResult[]) {
  console.log("\n--- Results ---\n");
  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.name} (${r.duration}ms)`);
    if (r.details) {
      console.log(`    ${r.details}`);
    }
    if (r.error) {
      console.log(`    Error: ${r.error}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n  ${passed}/${results.length} tests passed\n`);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
