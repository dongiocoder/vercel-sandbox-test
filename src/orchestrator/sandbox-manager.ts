import { Sandbox } from "@vercel/sandbox";
import * as fs from "fs";
import * as path from "path";
import { getSnapshotId } from "./snapshot-manager.js";
import { loadAgentConfig } from "./config-loader.js";
import type {
  ProcessRequest,
  AgentConfigBundle,
  AgentProcessResponse,
  ExecutionTiming,
} from "./types.js";

const AGENT_BUNDLE_PATH = path.join(process.cwd(), "dist/agent-server.mjs");

// Timeout constants
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_POLL_TIMEOUT_MS = 30_000; // 30 seconds
const HEALTH_POLL_INTERVAL_MS = 500; // 500ms between polls
const AGENT_PORT = 3000;

/**
 * Load the pre-built agent bundle from disk.
 * Must run `npm run build:agent` first.
 */
function loadAgentBundle(): string {
  if (!fs.existsSync(AGENT_BUNDLE_PATH)) {
    throw new Error(
      `Agent bundle not found at ${AGENT_BUNDLE_PATH}. Run "npm run build:agent" first.`
    );
  }
  return fs.readFileSync(AGENT_BUNDLE_PATH, "utf-8");
}

/**
 * Build the file list to write into the sandbox.
 * SDK expects { path, content: Buffer }[]
 */
function buildSandboxFiles(
  agentBundle: string,
  agentConfig: AgentConfigBundle
): { path: string; content: Buffer }[] {
  const fileMap: Record<string, string> = {
    "server.mjs": agentBundle,
    "CLAUDE.md": agentConfig.claudeMd,
    "agent-config.json": JSON.stringify(agentConfig.agentConfig, null, 2),
    "package.json": JSON.stringify(
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
  };

  // Add skill files under .claude/skills/
  for (const [relativePath, content] of Object.entries(agentConfig.skills)) {
    fileMap[`.claude/skills/${relativePath}`] = content;
  }

  return Object.entries(fileMap).map(([filePath, content]) => ({
    path: filePath,
    content: Buffer.from(content, "utf-8"),
  }));
}

/**
 * Poll the sandbox health endpoint until it responds or times out.
 */
async function pollHealth(
  domainUrl: string,
  timeoutMs: number = HEALTH_POLL_TIMEOUT_MS
): Promise<void> {
  const healthUrl = `${domainUrl}/health`;
  const deadline = Date.now() + timeoutMs;

  console.log(`[Sandbox] Polling health at ${healthUrl}...`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = await res.json();
        console.log(`[Sandbox] Health check passed:`, body);
        return;
      }
    } catch {
      // Server not ready yet, retry
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `[Sandbox] Health check timed out after ${timeoutMs}ms at ${healthUrl}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared sandbox setup: create, write files, install if needed, start server, poll health */
async function setupSandbox(
  request: ProcessRequest,
  timing?: ExecutionTiming
): Promise<{ sandbox: Sandbox; domainUrl: string }> {
  const agentConfig = loadAgentConfig(request.agentId);
  const agentBundle = loadAgentBundle();
  const snapshotId = getSnapshotId();

  // 1. Create sandbox
  const createStart = Date.now();
  let sandbox: Sandbox;

  if (snapshotId) {
    sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId },
      timeout: SANDBOX_TIMEOUT_MS,
      ports: [AGENT_PORT],
      resources: { vcpus: 2 },
    });
  } else {
    sandbox = await Sandbox.create({
      runtime: "node22",
      timeout: SANDBOX_TIMEOUT_MS,
      ports: [AGENT_PORT],
      resources: { vcpus: 2 },
    });
  }

  if (timing) timing.sandboxCreate = Date.now() - createStart;
  console.log(
    `[Sandbox] Created in ${Date.now() - createStart}ms (snapshot: ${snapshotId ? "yes" : "no"})`
  );

  // 2. Write agent files
  const writeStart = Date.now();
  const files = buildSandboxFiles(agentBundle, agentConfig);
  await sandbox.writeFiles(files);
  if (timing) timing.fileWrite = Date.now() - writeStart;
  console.log(
    `[Sandbox] Wrote ${files.length} files in ${Date.now() - writeStart}ms`
  );

  // 3. Install deps if no snapshot
  if (!snapshotId) {
    console.log("[Sandbox] No snapshot — running npm install...");
    const installStart = Date.now();
    const installResult = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--production"],
      env: { NODE_ENV: "production" },
    });
    const installTime = Date.now() - installStart;
    console.log(
      `[Sandbox] npm install completed in ${installTime}ms (exit: ${installResult.exitCode})`
    );
    if (installResult.exitCode !== 0) {
      const stderr = await installResult.stderr();
      throw new Error(`npm install failed: ${stderr}`);
    }
  }

  // 4. Start the agent server (detached)
  const serverStart = Date.now();
  await sandbox.runCommand({
    cmd: "node",
    args: ["server.mjs"],
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
      PORT: String(AGENT_PORT),
      AGENT_ID: request.agentId,
      CHANNEL: "sandbox",
      NODE_ENV: "production",
    },
    detached: true,
  });
  if (timing) timing.serverStart = Date.now() - serverStart;
  console.log(`[Sandbox] Server start command sent in ${Date.now() - serverStart}ms`);

  // 5. Poll health
  const healthStart = Date.now();
  const domainUrl = sandbox.domain(AGENT_PORT);
  await pollHealth(domainUrl);
  if (timing) timing.healthPoll = Date.now() - healthStart;
  console.log(`[Sandbox] Health poll completed in ${Date.now() - healthStart}ms`);

  return { sandbox, domainUrl };
}

/**
 * Execute a request inside an ephemeral Vercel Sandbox.
 *
 * Lifecycle: create → writeFiles → npm install (if no snapshot) → start server → poll health → proxy request → stop
 */
export async function executeInSandbox(
  request: ProcessRequest
): Promise<{ response: AgentProcessResponse; timing: ExecutionTiming }> {
  const timing: ExecutionTiming = {
    sandboxCreate: 0,
    fileWrite: 0,
    serverStart: 0,
    healthPoll: 0,
    agentProcess: 0,
    total: 0,
  };
  const totalStart = Date.now();

  let sandbox: Sandbox | null = null;

  try {
    const result = await setupSandbox(request, timing);
    sandbox = result.sandbox;

    // 6. Proxy request to sandbox
    const processStart = Date.now();
    const processUrl = `${result.domainUrl}/process`;
    const processBody = {
      message: request.message,
      conversationId: request.conversationId,
      customerId: request.customerId,
      customerEmail: request.customerEmail,
      modality: request.modality,
      gatewayContext: request.gatewayContext,
    };

    const res = await fetch(processUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(processBody),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Agent process request failed (${res.status}): ${errorText}`
      );
    }

    const agentResponse = (await res.json()) as AgentProcessResponse;
    timing.agentProcess = Date.now() - processStart;
    console.log(`[Sandbox] Agent processed in ${timing.agentProcess}ms`);

    timing.total = Date.now() - totalStart;
    return { response: agentResponse, timing };
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
        console.log("[Sandbox] Stopped");
      } catch (err) {
        console.error("[Sandbox] Error stopping sandbox:", err);
      }
    }
  }
}

/**
 * Execute a streaming request inside an ephemeral Vercel Sandbox.
 * Returns a ReadableStream of SSE events from the agent.
 */
export async function executeInSandboxStream(
  request: ProcessRequest
): Promise<{ stream: ReadableStream<Uint8Array>; cleanup: () => Promise<void> }> {
  const { sandbox, domainUrl } = await setupSandbox(request);

  // Initiate streaming request
  const streamUrl = `${domainUrl}/process/stream`;
  const processBody = {
    message: request.message,
    conversationId: request.conversationId,
    customerId: request.customerId,
    customerEmail: request.customerEmail,
    modality: request.modality,
    gatewayContext: request.gatewayContext,
  };

  const res = await fetch(streamUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(processBody),
  });

  if (!res.ok || !res.body) {
    await sandbox.stop();
    const errorText = await res.text();
    throw new Error(
      `Agent stream request failed (${res.status}): ${errorText}`
    );
  }

  const cleanup = async () => {
    try {
      await sandbox.stop();
      console.log("[Sandbox] Stopped (stream cleanup)");
    } catch (err) {
      console.error("[Sandbox] Error stopping sandbox:", err);
    }
  };

  return { stream: res.body, cleanup };
}
