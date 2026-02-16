import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { executeInSandbox, executeInSandboxStream } from "./sandbox-manager.js";
import { listAgentIds } from "./config-loader.js";
import type { ProcessRequest } from "./types.js";

export const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    service: "vercel-sandbox-orchestrator",
    agents: listAgentIds(),
    timestamp: new Date().toISOString(),
  });
});

// Process a message via ephemeral sandbox (non-streaming)
app.post("/process", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json<ProcessRequest>();

    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }
    if (!body.agentId) {
      return c.json({ error: "agentId is required" }, 400);
    }

    console.log(
      `[Orchestrator] Processing request for agent: ${body.agentId}`
    );

    const { response, timing } = await executeInSandbox(body);

    return c.json({
      ...response,
      timing,
      orchestratorDuration: Date.now() - startTime,
    });
  } catch (error) {
    console.error("[Orchestrator] Error:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        duration: Date.now() - startTime,
      },
      500
    );
  }
});

// Streaming endpoint — proxies SSE from sandbox agent
app.post("/process/stream", async (c) => {
  try {
    const body = await c.req.json<ProcessRequest>();

    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }
    if (!body.agentId) {
      return c.json({ error: "agentId is required" }, 400);
    }

    console.log(
      `[Orchestrator] Streaming request for agent: ${body.agentId}`
    );

    const { stream, cleanup } = await executeInSandboxStream(body);

    // Return the SSE stream from the sandbox, clean up on completion
    const response = new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });

    // Schedule cleanup after stream ends
    // The stream's reader will signal completion, then we stop the sandbox
    stream
      .pipeTo(new WritableStream())
      .catch(() => {})
      .finally(() => cleanup());

    return response;
  } catch (error) {
    console.error("[Orchestrator] Streaming error:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// List available agents
app.get("/agents", (c) => {
  return c.json({ agents: listAgentIds() });
});
