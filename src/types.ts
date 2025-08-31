// Re-export all types from the agent-client-protocol
export * from "@zed-industries/agent-client-protocol";

// Import Zod for runtime validation
import { z } from 'zod';

// Import ACP types for validation
import type { NewSessionRequest, LoadSessionRequest, PromptRequest } from "@zed-industries/agent-client-protocol";

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

// Validation helper functions using Zod schemas

export function validateSessionId(sessionId: unknown): string {
  return SessionIdSchema.parse(sessionId);
}

export function validateNewSessionRequest(data: unknown): NewSessionRequest {
  const validated = NewSessionRequestSchema.parse(data);
  return validated as NewSessionRequest;
}

export function validateLoadSessionRequest(data: unknown): LoadSessionRequest {
  const validated = LoadSessionRequestSchema.parse(data);
  return validated as LoadSessionRequest;
}

export function validatePromptRequest(data: unknown): PromptRequest {
  const validated = PromptRequestSchema.parse(data);
  return validated as PromptRequest;
}

// Essential MIME type mappings
export const MIME_TYPE_MAPPINGS: Record<string, string> = {
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
};
