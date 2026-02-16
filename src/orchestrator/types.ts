/**
 * Shared types for the orchestrator layer.
 */

/** Request body for POST /process and POST /process/stream */
export interface ProcessRequest {
  message: string;
  agentId: string;
  conversationId?: string;
  customerId?: string;
  customerEmail?: string;
  modality?: string;
  gatewayContext?: Record<string, unknown>;
}

/** Loaded agent configuration bundle */
export interface AgentConfigBundle {
  claudeMd: string;
  agentConfig: Record<string, unknown>;
  skills: Record<string, string>; // relativePath -> fileContent
}

/** Response shape from the agent inside the sandbox */
export interface AgentProcessResponse {
  requestId: string;
  response: string;
  guidesUsed?: string[];
  confidence?: string;
  duration: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

/** Timing breakdown for a sandbox execution */
export interface ExecutionTiming {
  sandboxCreate: number;
  fileWrite: number;
  serverStart: number;
  healthPoll: number;
  agentProcess: number;
  total: number;
}
