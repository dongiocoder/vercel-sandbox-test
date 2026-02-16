import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { v4 as uuidv4 } from "uuid";
import { processMessage, processMessageStream } from "./agent.js";
import { streamSSE } from "hono/streaming";
import "dotenv/config";

const app = new Hono();

// Configuration
const config = {
  agentId: process.env.AGENT_ID || "unknown",
  channel: process.env.CHANNEL || "dev",
  port: parseInt(process.env.PORT || "3000", 10),
};

// Middleware
app.use("*", logger());
app.use("*", cors());

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    agentId: config.agentId,
    channel: config.channel,
    timestamp: new Date().toISOString(),
  });
});

// Process incoming message
app.post("/process", async (c) => {
  const requestId = c.req.header("X-Request-ID") || uuidv4();
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const { message, conversationId, customerId, customerEmail, modality, gatewayContext } = body;

    if (!message && !gatewayContext) {
      return c.json({ error: "Message or gateway context is required" }, 400);
    }

    console.log(`[${requestId}] Processing ${modality || "unknown"} message for conversation: ${conversationId}`);

    // Process through Claude Agent SDK
    const result = await processMessage({
      message: message || "",
      conversationId,
      customerId,
      metadata: {
        customerEmail,
        modality,
        ...gatewayContext,
      },
      requestId,
    });

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Completed in ${duration}ms`);

    return c.json({
      requestId,
      response: result.response,
      guidesUsed: result.guidesUsed,
      confidence: result.confidence,
      duration,
      metadata: result.metadata,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error after ${duration}ms:`, error);

    return c.json(
      {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
        duration,
      },
      500
    );
  }
});

// Streaming endpoint - Server-Sent Events
app.post("/process/stream", async (c) => {
  const requestId = c.req.header("X-Request-ID") || uuidv4();
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const { message, conversationId, customerId, customerEmail, modality, gatewayContext } = body;

    if (!message && !gatewayContext) {
      return c.json({ error: "Message or gateway context is required" }, 400);
    }

    console.log(`[${requestId}] Streaming ${modality || "unknown"} message for conversation: ${conversationId}`);

    return streamSSE(c, async (stream) => {
      // Send initial event with request ID
      await stream.writeSSE({
        event: "start",
        data: JSON.stringify({ requestId, startTime }),
      });

      // Process with streaming
      const generator = processMessageStream({
        message: message || "",
        conversationId,
        customerId,
        metadata: {
          customerEmail,
          modality,
          ...gatewayContext,
        },
        requestId,
      });

      for await (const chunk of generator) {
        switch (chunk.type) {
          case "thinking":
            await stream.writeSSE({
              event: "thinking",
              data: chunk.content,
            });
            break;

          case "tool_start":
            await stream.writeSSE({
              event: "tool_start",
              data: JSON.stringify({
                toolName: chunk.toolName,
                toolId: chunk.toolId,
                input: chunk.input,
              }),
            });
            break;

          case "tool_end":
            await stream.writeSSE({
              event: "tool_end",
              data: JSON.stringify({
                toolName: chunk.toolName,
                toolId: chunk.toolId,
                success: chunk.success,
                result: chunk.result,
              }),
            });
            break;

          case "todo":
            await stream.writeSSE({
              event: "todo",
              data: JSON.stringify({ todos: chunk.todos }),
            });
            break;

          case "structured_output":
            await stream.writeSSE({
              event: "structured_output",
              data: JSON.stringify(chunk.content),
            });
            break;

          case "done":
            const duration = Date.now() - startTime;
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({
                duration,
                confidence: chunk.metadata?.confidence || "high",
                usage: chunk.usage,
                metadata: chunk.metadata,
              }),
            });
            break;

          case "error":
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: chunk.content }),
            });
            break;
        }
      }
    });
  } catch (error) {
    console.error(`[${requestId}] Streaming setup error:`, error);
    return c.json(
      {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// Graceful shutdown endpoint
app.post("/shutdown", async (c) => {
  console.log("Shutdown requested...");

  // Give time for response to be sent
  setTimeout(() => {
    process.exit(0);
  }, 1000);

  return c.json({ status: "shutting_down" });
});

// Handle graceful shutdown signals
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  process.exit(0);
});

// Start server
console.log(`Starting XO Agent server...`);
console.log(`  Agent ID: ${config.agentId}`);
console.log(`  Channel: ${config.channel}`);
console.log(`  Port: ${config.port}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`Server running on http://localhost:${config.port}`);
