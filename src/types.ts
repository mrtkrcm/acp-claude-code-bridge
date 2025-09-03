// Re-export all types from our enhanced schema
export * from "./schema.js";

// Import specific types for local use
import type {
  PlanEntry as ACPPlanEntry,
  ToolCallLocation as ACPToolCallLocation,
  ToolCallContent as ACPToolCallContent,
  PermissionOption as ACPPermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  Annotations,
  ContentBlock,
  EmbeddedResourceResource
} from "./schema.js";

// Re-export with local names for convenience
// Enhanced PlanEntry with optional title field for better UX
export interface PlanEntry extends ACPPlanEntry {
  title?: string;
}
export type ToolCallLocation = ACPToolCallLocation;
export type ToolCallContent = ACPToolCallContent;
export type PermissionOption = ACPPermissionOption;
export type ACPRequestPermissionRequest = RequestPermissionRequest;
export type ACPRequestPermissionResponse = RequestPermissionResponse;
export type ACPAnnotations = Annotations;
export type ACPContentBlock = ContentBlock;
export type ACPEmbeddedResource = EmbeddedResourceResource;

// Extended types for enhanced ACP features
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

// Enhanced tool content with diff support
export interface EnhancedToolContent {
  type: "content" | "diff" | "resource";
  content?: ACPContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
  resource?: ACPEmbeddedResource;
}

// Plan entry status type
export type PlanStatus = "pending" | "in_progress" | "completed" | "failed";
export type PlanPriority = "high" | "medium" | "low";

// Session update types
export type SessionUpdateType = 
  | "agent_message_chunk"
  | "agent_thought_chunk" 
  | "user_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan";

// Enhanced session capabilities
export interface EnhancedPromptCapabilities {
  audio: boolean;
  embeddedContext: boolean;
  image: boolean;
  plans: boolean;
  thoughtStreaming: boolean;
}

// Tool operation context for enhanced titles and content
export interface ToolOperationContext {
  toolName: string;
  input: unknown;
  operationType?: "create" | "read" | "edit" | "delete" | "move" | "search" | "execute" | "other";
  affectedFiles?: string[];
  complexity?: "simple" | "moderate" | "complex";
  streamingOperationId?: string; // For real-time streaming tracking
}

// Import Zod for runtime validation
import { z } from 'zod';

// Claude Code SDK message types
export interface ClaudeMessage {
  type: string;
  text?: string;
  id?: string;
  tool_name?: string;
  input?: unknown;
  output?: string;
  error?: string;
  event?: ClaudeStreamEvent;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      // For tool_use blocks in assistant messages
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      // For tool_result in user messages
      tool_use_id?: string;
      content?: string;
    }>;
  };
  result?: string;
  subtype?: string;
}

export interface ClaudeStreamEvent {
  type: string;
  content_block?: {
    type: string;
    text?: string;
  };
  delta?: {
    type: string;
    text?: string;
  };
}

export interface ClaudeQueryOptions {
  maxTurns?: number;
  permissionMode?: "ask_on_edit" | "ask_always" | "auto" | "default";
  onStatus?: (status: string) => void;
  allowedTools?: string[];
  disallowedTools?: string[];
  toolPermissions?: Record<string, PermissionLevel>;
}

// Basic resource metadata for file operations
export interface ResourceMetadata {
  size?: number;
  encoding?: string;
  lastModified?: string;
}

// Tool permission system types
export type PermissionLevel = "allow" | "deny" | "ask";



// Zod validation schemas for runtime type checking
export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
export const SessionIdSchema = z.string().uuid();

// Simplified validation schemas that match ACP protocol structure
export const NewSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  mcpServers: z.array(z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).default([]),
  })).default([]),
});

export const LoadSessionRequestSchema = z.object({
  sessionId: SessionIdSchema,
  cwd: z.string().min(1),
  mcpServers: z.array(z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).default([]),
  })).default([]),
});

export const PromptRequestSchema = z.object({
  sessionId: SessionIdSchema,
  prompt: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })).min(1),
});

// Validation is now handled by Zod schemas in the protocol layer

// Essential MIME type mappings
export const MIME_TYPE_MAPPINGS: Record<string, string> = {
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
};
