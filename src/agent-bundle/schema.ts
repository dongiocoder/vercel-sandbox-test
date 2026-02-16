/**
 * Structured Output Schema for XO Agent
 *
 * This schema forces Claude to return responses in a structured format,
 * separating customer-facing response text from internal metadata.
 *
 * Used with Claude Agent SDK's outputFormat parameter.
 */

// ============================================================================
// TypeScript Types
// ============================================================================

/**
 * Flag types for response metadata
 */
export type ResponseFlag =
  | "NO_GUIDE_FOUND"
  | "NEEDS_ESCALATION"
  | "SENSITIVE_TOPIC"
  | "MULTIPLE_ISSUES"
  | "PII_DETECTED";

/**
 * Confidence level for agent response
 */
export type ConfidenceLevel = "high" | "medium" | "low";

/**
 * Customer emotional state detected from message
 */
export type EmotionalState =
  | "frustrated"
  | "confused"
  | "neutral"
  | "happy"
  | "angry"
  | "anxious";

/**
 * Customer analysis extracted from message content
 */
export interface CustomerAnalysis {
  /** Detected emotional state from customer message */
  emotionalState: EmotionalState | string;
  /** Distinct issues/questions identified in the message */
  issuesIdentified: string[];
}

/**
 * Flags with conditional explanations
 */
export interface ResponseFlags {
  /** List of flags applicable to this response */
  list: ResponseFlag[];
  /** Required when NEEDS_ESCALATION in list - explains why escalation is needed */
  escalationReason?: string;
  /** Suggested guide path when NO_GUIDE_FOUND in list */
  suggestedGuide?: string;
  /** Required when SENSITIVE_TOPIC in list - which topics were detected */
  sensitiveTopicsDetected?: string[];
}

/**
 * Self-assessment against QA criteria
 */
export interface QualityChecks {
  /** All customer issues addressed in response */
  allIssuesAddressed?: boolean;
  /** Response tone matches customer's emotional state */
  toneMatchesEmotionalState?: boolean;
  /** Response includes clear next steps */
  hasNextSteps?: boolean;
  /** Response follows brand voice guidelines */
  followsBrandVoice?: boolean;
}

/**
 * Response metadata for analysis and routing
 */
export interface ResponseMetadata {
  /** Confidence level: high (guide match), medium (partial), low (no guide) */
  confidence: ConfidenceLevel;
  /** File paths of guides consulted during response generation */
  guidesUsed: string[];
  /** Analysis of customer message content */
  customerAnalysis: CustomerAnalysis;
  /** Flags for review and routing decisions */
  flags: ResponseFlags;
  /** Self-assessment against QA criteria */
  qualityChecks?: QualityChecks;
}

/**
 * Complete structured agent response
 */
export interface AgentResponse {
  /** Customer-facing response text - the ONLY text the customer will see */
  response: string;
  /** Internal metadata for analysis, tracing, and routing */
  metadata: ResponseMetadata;
}

// ============================================================================
// JSON Schema for Claude Agent SDK outputFormat
// ============================================================================

/**
 * JSON Schema definition for structured output.
 * Used with Claude Agent SDK's outputFormat parameter.
 */
export const responseJsonSchema = {
  type: "object",
  required: ["response", "metadata"],
  properties: {
    response: {
      type: "string",
      description:
        "The customer-facing response text. This is the ONLY text the customer will see. Do not include any internal notes, reasoning, or metadata here.",
    },
    metadata: {
      type: "object",
      required: ["confidence", "guidesUsed", "customerAnalysis", "flags"],
      properties: {
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description:
            "high: clear guide match with direct answer, medium: partial match or adapted response, low: no matching guide found",
        },
        guidesUsed: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths of guides consulted (e.g., 'guides/password-reset.md')",
        },
        customerAnalysis: {
          type: "object",
          required: ["emotionalState", "issuesIdentified"],
          properties: {
            emotionalState: {
              type: "string",
              description:
                "Detected from customer message: frustrated, confused, neutral, happy, angry, anxious",
            },
            issuesIdentified: {
              type: "array",
              items: { type: "string" },
              description:
                "Distinct issues or questions from customer message (e.g., ['password reset', 'account locked'])",
            },
          },
        },
        flags: {
          type: "object",
          required: ["list"],
          properties: {
            list: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "NO_GUIDE_FOUND",
                  "NEEDS_ESCALATION",
                  "SENSITIVE_TOPIC",
                  "MULTIPLE_ISSUES",
                  "PII_DETECTED",
                ],
              },
              description: "Flags for review and routing decisions",
            },
            escalationReason: {
              type: "string",
              description:
                "REQUIRED when NEEDS_ESCALATION in list. Why escalation is needed based on configured escalation rules.",
            },
            suggestedGuide: {
              type: "string",
              description:
                "RECOMMENDED when NO_GUIDE_FOUND in list. Suggested guide path that should be created.",
            },
            sensitiveTopicsDetected: {
              type: "array",
              items: { type: "string" },
              description:
                "REQUIRED when SENSITIVE_TOPIC in list. Which sensitive topics were detected.",
            },
          },
        },
        qualityChecks: {
          type: "object",
          description: "Self-assessment against QA criteria from qa-rubric.md",
          properties: {
            allIssuesAddressed: {
              type: "boolean",
              description: "All customer issues addressed in response",
            },
            toneMatchesEmotionalState: {
              type: "boolean",
              description: "Response tone matches customer emotional state",
            },
            hasNextSteps: {
              type: "boolean",
              description: "Response includes clear next steps",
            },
            followsBrandVoice: {
              type: "boolean",
              description: "Response follows brand voice guidelines",
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Type helper to extract type from JSON schema
 */
export type ResponseJsonSchema = typeof responseJsonSchema;
