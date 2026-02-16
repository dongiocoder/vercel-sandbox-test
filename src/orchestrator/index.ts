import { serve } from "@hono/node-server";
import { app } from "./server.js";
import "dotenv/config";

const PORT = parseInt(process.env.ORCHESTRATOR_PORT || "4000", 10);

// Validate required env vars
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required. Set it in .env.local");
  process.exit(1);
}

console.log("Starting Vercel Sandbox Orchestrator...");
console.log(`  Port: ${PORT}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "missing"}`);
console.log(`  VERCEL_TOKEN: ${process.env.VERCEL_TOKEN ? "set" : "not set"}`);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`Orchestrator running on http://localhost:${PORT}`);
