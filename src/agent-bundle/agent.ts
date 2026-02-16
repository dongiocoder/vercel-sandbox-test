import { query, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { responseJsonSchema, AgentResponse, ResponseMetadata } from "./schema.js";

// Debug logging - enable via AGENT_DEBUG=true environment variable
const DEBUG = process.env.AGENT_DEBUG === "true";
const debug = (...args: unknown[]) => DEBUG && console.log("[DEBUG]", ...args);

// Session management for multi-turn conversations
// Maps conversationId -> Claude Agent SDK session_id
const activeSessions = new Map<string, string>();

// Find Claude Code CLI executable path
function findClaudeCodePath(): string | undefined {
  // First, try the bundled CLI from node_modules (preferred - no global install needed)
  const bundledPath = path.join(
    process.cwd(),
    "node_modules/@anthropic-ai/claude-agent-sdk/cli.js"
  );

  if (fs.existsSync(bundledPath)) {
    console.log("[Agent] Using bundled Claude CLI at:", bundledPath);
    return bundledPath;
  }

  // Sandbox-specific: check global npm install path (used in Vercel Sandbox)
  const globalNpmPath =
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
  if (fs.existsSync(globalNpmPath)) {
    console.log("[Agent] Using global npm Claude CLI at:", globalNpmPath);
    return globalNpmPath;
  }

  // Fallback: try to find global install via 'which' command
  try {
    const result = execSync("which claude", { encoding: "utf-8" }).trim();
    if (result && fs.existsSync(result)) {
      console.log("[Agent] Found global Claude Code at:", result);
      return result;
    }
  } catch {
    // 'which' failed, try common paths
  }

  // Fallback: common global npm paths
  const commonPaths = ["/usr/local/bin/claude", "/usr/bin/claude"];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      console.log("[Agent] Found Claude Code at:", p);
      return p;
    }
  }

  console.warn("[Agent] Claude Code CLI not found!");
  return undefined;
}

// Cache the Claude Code path
let claudeCodePath: string | undefined;

function getClaudeCodePath(): string | undefined {
  if (claudeCodePath === undefined) {
    claudeCodePath = findClaudeCodePath();
  }
  return claudeCodePath;
}

// Per-modality runtime settings (extensible structure)
interface ToolSettings {
  allowedTools?: string[];
  disabledTools?: string[];
}

interface McpSettingsOverride {
  enabledServers?: string[];
  disabledServers?: string[];
}

interface ModalityRuntimeSettings {
  maxThinkingTokens?: number;
  maxTurns?: number;
  toolSettings?: ToolSettings;
  mcpSettings?: McpSettingsOverride;
}

// Agent configuration loaded from agent-config.json (generated at deploy time)
interface AgentConfig {
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  additionalInstructions: string;
  maxTurns: number;
  // Per-modality overrides (extensible)
  modalitySettings?: {
    chat?: ModalityRuntimeSettings;
    email?: ModalityRuntimeSettings;
    voice?: ModalityRuntimeSettings;
  };
}

export interface ProcessMessageInput {
  message: string;
  conversationId?: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
  requestId: string;
}

export interface ProcessMessageResult {
  response: string;
  guidesUsed: string[];
  confidence: "high" | "medium" | "low";
  toolsUsed?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  };
  /** Structured metadata from agent response */
  metadata?: ResponseMetadata;
}

// Load agent configuration from file
function loadAgentConfig(): AgentConfig {
  const configPath = path.join(process.cwd(), "agent-config.json");

  if (fs.existsSync(configPath)) {
    try {
      const configContent = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(configContent);
    } catch (error) {
      console.error("[Agent] Failed to parse agent-config.json:", error);
    }
  }

  // Default configuration if file doesn't exist
  console.warn("[Agent] agent-config.json not found, using defaults");
  return {
    allowedTools: ["Read", "Glob", "Grep"],
    mcpServers: {},
    additionalInstructions: "",
    maxTurns: 20,
  };
}

// Cache the config
let agentConfig: AgentConfig | null = null;

function getAgentConfig(): AgentConfig {
  if (!agentConfig) {
    agentConfig = loadAgentConfig();
    console.log("[Agent] Loaded config:", {
      allowedTools: agentConfig.allowedTools,
      mcpServers: Object.keys(agentConfig.mcpServers),
      maxTurns: agentConfig.maxTurns,
      hasAdditionalInstructions: !!agentConfig.additionalInstructions,
      modalitySettings: agentConfig.modalitySettings
        ? Object.keys(agentConfig.modalitySettings)
        : [],
    });
  }
  return agentConfig;
}

// Effective settings after applying per-modality overrides
interface EffectiveSettings {
  maxTurns: number;
  maxThinkingTokens: number;
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Get effective settings for a specific modality
 * Applies modality-specific overrides to base config
 */
function getEffectiveSettings(
  config: AgentConfig,
  modality: string | undefined
): EffectiveSettings {
  const modalitySettings = modality
    ? config.modalitySettings?.[modality as keyof NonNullable<AgentConfig["modalitySettings"]>]
    : undefined;

  // SDK settings with modality overrides (defaults based on modality type)
  let maxTurns = config.maxTurns;
  let maxThinkingTokens = 10000; // Default

  if (modalitySettings) {
    maxTurns = modalitySettings.maxTurns ?? maxTurns;
    maxThinkingTokens = modalitySettings.maxThinkingTokens ?? maxThinkingTokens;
  } else if (modality) {
    // Apply sensible defaults when no explicit settings exist
    switch (modality) {
      case "chat":
        maxThinkingTokens = 5000;
        maxTurns = Math.min(maxTurns, 15);
        break;
      case "voice":
        maxThinkingTokens = 5000;
        maxTurns = Math.min(maxTurns, 10);
        break;
      // email uses full defaults (10000/20)
    }
  }

  // Tool settings with modality overrides
  let allowedTools = [...config.allowedTools];
  if (modalitySettings?.toolSettings?.allowedTools) {
    allowedTools = modalitySettings.toolSettings.allowedTools;
  }
  if (modalitySettings?.toolSettings?.disabledTools) {
    const disabled = new Set(modalitySettings.toolSettings.disabledTools);
    allowedTools = allowedTools.filter((t) => !disabled.has(t));
  }

  // MCP settings with modality overrides
  let mcpServers = { ...config.mcpServers };
  if (modalitySettings?.mcpSettings?.enabledServers) {
    const enabled = new Set(modalitySettings.mcpSettings.enabledServers);
    mcpServers = Object.fromEntries(
      Object.entries(mcpServers).filter(([name]) => enabled.has(name))
    );
  }
  if (modalitySettings?.mcpSettings?.disabledServers) {
    const disabled = new Set(modalitySettings.mcpSettings.disabledServers);
    mcpServers = Object.fromEntries(
      Object.entries(mcpServers).filter(([name]) => !disabled.has(name))
    );
  }

  return { maxTurns, maxThinkingTokens, allowedTools, mcpServers };
}

/**
 * Build context string from metadata
 */
function buildContextString(input: ProcessMessageInput): string {
  const { conversationId, customerId, metadata } = input;
  const contextParts: string[] = [];

  if (conversationId) {
    contextParts.push(`Conversation ID: ${conversationId}`);
  }
  if (customerId) {
    contextParts.push(`Customer ID: ${customerId}`);
  }
  if (metadata) {
    const customerEmail = metadata.customerEmail;
    const modality = metadata.modality;
    if (customerEmail) {
      contextParts.push(`Customer Email: ${customerEmail}`);
    }
    if (modality) {
      contextParts.push(`Channel: ${modality}`);
    }
  }

  return contextParts.length > 0
    ? `Context:\n${contextParts.join("\n")}\n\n`
    : "";
}

/**
 * Process a message using the Claude Agent SDK (non-streaming)
 * Collects all responses and returns the final result
 */
export async function processMessage(
  input: ProcessMessageInput
): Promise<ProcessMessageResult> {
  const { message, conversationId, requestId, metadata } = input;
  const config = getAgentConfig();

  // Get modality from metadata and apply per-modality settings
  const modality = metadata?.modality as string | undefined;
  const effective = getEffectiveSettings(config, modality);

  // Check for existing session to resume for multi-turn conversations
  const existingSessionId = conversationId
    ? activeSessions.get(conversationId)
    : undefined;

  console.log(`[${requestId}] Starting agent processing with SDK...`, {
    modality: modality || "default",
    conversationId: conversationId || "none",
    resumingSession: existingSessionId ? "yes" : "no",
    maxTurns: effective.maxTurns,
    maxThinkingTokens: effective.maxThinkingTokens,
    allowedTools: effective.allowedTools.length,
  });

  const contextString = buildContextString(input);
  const fullPrompt = contextString
    ? `${contextString}Customer message:\n${message}`
    : message;

  const toolsUsed: string[] = [];
  let responseText = "";
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
  };

  let structuredMetadata: ResponseMetadata | undefined;

  try {
    for await (const sdkMessage of query({
      prompt: fullPrompt,
      options: {
        // Path to Claude Code CLI executable
        pathToClaudeCodeExecutable: getClaudeCodePath(),

        // No executable override — defaults to "node" (sandbox runs Node.js)

        // CRITICAL: Load CLAUDE.md from project directory
        settingSources: ["project"],

        // Use Claude Code's system prompt with optional appended instructions
        systemPrompt: config.additionalInstructions
          ? {
              type: "preset",
              preset: "claude_code",
              append: config.additionalInstructions,
            }
          : {
              type: "preset",
              preset: "claude_code",
            },

        // Tools with per-modality overrides
        allowedTools: effective.allowedTools,

        // MCP servers with per-modality overrides
        mcpServers: effective.mcpServers,

        // Container working directory (where CLAUDE.md and .claude/ are)
        cwd: process.cwd(),

        // Automated agent - bypass permission prompts
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,

        // Limits with per-modality overrides
        maxTurns: effective.maxTurns,

        // Enable extended thinking with per-modality limits
        maxThinkingTokens: effective.maxThinkingTokens,

        // Structured output format for reliable response/metadata separation
        outputFormat: {
          type: "json_schema",
          schema: responseJsonSchema,
        },

        // Resume existing session for multi-turn conversations
        ...(existingSessionId && { resume: existingSessionId }),
      },
    })) {
      // Capture session ID from init message for future turns
      if (
        sdkMessage.type === "system" &&
        sdkMessage.subtype === "init" &&
        conversationId &&
        sdkMessage.session_id
      ) {
        activeSessions.set(conversationId, sdkMessage.session_id);
        console.log(
          `[${requestId}] Session started/resumed: ${sdkMessage.session_id}`
        );
      }

      // Track tool usage from assistant messages
      if (sdkMessage.type === "assistant") {
        for (const block of sdkMessage.message.content) {
          if (block.type === "tool_use") {
            toolsUsed.push(block.name);
          }
        }
      }

      // Capture final result with usage stats
      if (sdkMessage.type === "result" && sdkMessage.subtype === "success") {
        usage = {
          inputTokens: sdkMessage.usage?.input_tokens || 0,
          outputTokens: sdkMessage.usage?.output_tokens || 0,
          totalCostUsd: sdkMessage.total_cost_usd || 0,
        };

        if (sdkMessage.structured_output) {
          const output = sdkMessage.structured_output as AgentResponse;
          responseText = output.response;
          structuredMetadata = output.metadata;
          console.log(`[${requestId}] Got structured output`, {
            confidence: structuredMetadata.confidence,
            flags: structuredMetadata.flags?.list,
          });
        } else {
          console.error(`[${requestId}] No structured_output in result`);
          responseText = "I apologize, but I encountered an issue generating a response.";
        }
      }

      // Log errors
      if (sdkMessage.type === "result" && sdkMessage.is_error) {
        console.error(`[${requestId}] SDK error:`, sdkMessage);
      }
    }

    console.log(`[${requestId}] Agent response generated`, {
      toolsUsed,
      responseLength: responseText.length,
      hasStructuredMetadata: !!structuredMetadata,
    });

    return {
      response: responseText,
      guidesUsed: structuredMetadata?.guidesUsed || toolsUsed.filter((t) => t === "Read"),
      confidence: structuredMetadata?.confidence || (toolsUsed.length > 0 ? "high" : "medium"),
      toolsUsed,
      usage,
      metadata: structuredMetadata,
    };
  } catch (error) {
    console.error(`[${requestId}] Agent error:`, error);
    throw error;
  }
}

/**
 * Streaming message chunk types
 */
export type StreamChunk =
  | { type: "thinking"; content: string }
  | { type: "tool_start"; toolName: string; toolId: string; input?: unknown }
  | { type: "tool_end"; toolName: string; toolId: string; success: boolean; result?: unknown }
  | { type: "todo"; todos: Array<{ content: string; status: string; activeForm: string }> }
  | { type: "structured_output"; content: AgentResponse }
  | { type: "done"; content: string; usage?: ProcessMessageResult["usage"]; metadata?: ResponseMetadata }
  | { type: "error"; content: string };

/**
 * Process a message with streaming response using Claude Agent SDK
 * Yields chunks as they arrive
 */
export async function* processMessageStream(
  input: ProcessMessageInput
): AsyncGenerator<StreamChunk> {
  const { message, conversationId, requestId, metadata } = input;
  const config = getAgentConfig();

  const modality = metadata?.modality as string | undefined;
  const effective = getEffectiveSettings(config, modality);

  const existingSessionId = conversationId
    ? activeSessions.get(conversationId)
    : undefined;

  console.log(`[${requestId}] Starting streaming agent processing with SDK...`, {
    modality: modality || "default",
    conversationId: conversationId || "none",
    resumingSession: existingSessionId ? "yes" : "no",
    maxTurns: effective.maxTurns,
    maxThinkingTokens: effective.maxThinkingTokens,
    allowedTools: effective.allowedTools.length,
  });

  const contextString = buildContextString(input);
  const fullPrompt = contextString
    ? `${contextString}Customer message:\n${message}`
    : message;

  const toolsUsed: string[] = [];
  const pendingTools = new Map<string, string>();
  let hasStreamedThinking = false;

  try {
    for await (const sdkMessage of query({
      prompt: fullPrompt,
      options: {
        pathToClaudeCodeExecutable: getClaudeCodePath(),

        // No executable override — defaults to "node"

        settingSources: ["project"],

        systemPrompt: config.additionalInstructions
          ? {
              type: "preset",
              preset: "claude_code",
              append: config.additionalInstructions,
            }
          : {
              type: "preset",
              preset: "claude_code",
            },

        allowedTools: effective.allowedTools,
        mcpServers: effective.mcpServers,
        cwd: process.cwd(),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: effective.maxTurns,
        maxThinkingTokens: effective.maxThinkingTokens,
        includePartialMessages: true,

        outputFormat: {
          type: "json_schema",
          schema: responseJsonSchema,
        },

        ...(existingSessionId && { resume: existingSessionId }),
      },
    })) {
      // Capture session ID from init message for future turns
      if (
        sdkMessage.type === "system" &&
        sdkMessage.subtype === "init" &&
        conversationId &&
        sdkMessage.session_id
      ) {
        activeSessions.set(conversationId, sdkMessage.session_id);
        console.log(
          `[${requestId}] Session started/resumed: ${sdkMessage.session_id}`
        );
      }

      debug(`[${requestId}] SDK message:`, sdkMessage.type,
        sdkMessage.type === "result" ? `subtype=${(sdkMessage as unknown as {subtype?: string}).subtype}` : "");

      if (sdkMessage.type === "assistant") {
        for (const block of sdkMessage.message.content) {
          if (block.type === "thinking") {
            if (!hasStreamedThinking) {
              yield { type: "thinking", content: block.thinking };
            }
          } else if (block.type === "tool_use") {
            toolsUsed.push(block.name);
            pendingTools.set(block.id, block.name);

            if (block.name === "TodoWrite" && block.input && typeof block.input === "object" && "todos" in block.input) {
              yield {
                type: "todo",
                todos: (block.input as { todos: Array<{ content: string; status: string; activeForm: string }> }).todos,
              };
            }

            yield {
              type: "tool_start",
              toolName: block.name,
              toolId: block.id,
              input: block.input,
            };
          }
        }
      } else if (sdkMessage.type === "user") {
        for (const block of sdkMessage.message.content) {
          if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
            const toolName = pendingTools.get(block.tool_use_id) || "unknown";
            const success = !block.is_error;
            yield {
              type: "tool_end",
              toolName,
              toolId: block.tool_use_id,
              success,
              result: block.content,
            };
            pendingTools.delete(block.tool_use_id);
          }
        }
      } else if (sdkMessage.type === "stream_event") {
        const event = sdkMessage.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "thinking_delta"
        ) {
          hasStreamedThinking = true;
          yield { type: "thinking", content: event.delta.thinking };
        }
      } else if (sdkMessage.type === "result") {
        if (sdkMessage.subtype === "success") {
          debug(`[${requestId}] SDK result message keys:`, Object.keys(sdkMessage));
          debug(`[${requestId}] SDK result.structured_output:`, sdkMessage.structured_output);

          const resultUsage = {
            inputTokens: sdkMessage.usage?.input_tokens || 0,
            outputTokens: sdkMessage.usage?.output_tokens || 0,
            totalCostUsd: sdkMessage.total_cost_usd || 0,
          };

          if (sdkMessage.structured_output) {
            const output = sdkMessage.structured_output as AgentResponse;

            yield { type: "structured_output", content: output };

            yield {
              type: "done",
              content: output.response,
              usage: resultUsage,
              metadata: output.metadata,
            };
            console.log(`[${requestId}] Got structured streaming output`, {
              confidence: output.metadata.confidence,
              flags: output.metadata.flags?.list,
            });
          } else {
            console.error(`[${requestId}] No structured_output in streaming result`);
            yield {
              type: "done",
              content: "I apologize, but I encountered an issue generating a response.",
              usage: resultUsage,
            };
          }
        } else {
          const subtype = (sdkMessage as { subtype?: string }).subtype || "unknown";
          const errors = "errors" in sdkMessage ? (sdkMessage as { errors?: string[] }).errors : undefined;

          let errorMsg = `Agent error: ${subtype}`;
          if (errors && errors.length > 0) {
            errorMsg += ` - ${errors.join(", ")}`;
          }

          console.error(`[${requestId}] SDK result error:`, { subtype, errors });
          yield { type: "error", content: errorMsg };
        }
      }
    }

    console.log(`[${requestId}] Streaming response complete`, {
      toolsUsed,
    });
  } catch (error) {
    console.error(`[${requestId}] Streaming error:`, error);
    yield {
      type: "error",
      content: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
