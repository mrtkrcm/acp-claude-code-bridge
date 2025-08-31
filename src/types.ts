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

// Enhanced client capabilities for experimental features
export interface ExtendedClientCapabilities {
  experimental?: {
    enhancedContent?: boolean;     // Support for rich content blocks
    toolTiming?: boolean;         // Support for tool execution timing
    progressUpdates?: boolean;    // Support for progress indicators
    richDiffs?: boolean;         // Support for enhanced diff metadata
    resourceMetadata?: boolean;  // Support for detailed resource information
    streamingContent?: boolean;   // Support for streaming tool output
    toolCallBatching?: boolean;   // Support for batching multiple tool calls
  };
}

// Tool execution timing metadata
export interface ToolExecutionTiming {
  startTime: number;            // Timestamp when tool execution started
  endTime?: number;            // Timestamp when tool execution completed
  duration?: number;           // Duration in milliseconds
  estimatedDuration?: number;  // Estimated duration for progress indication
}

// Enhanced diff metadata
export interface DiffMetadata {
  linesAdded: number;
  linesRemoved: number;
  language?: string;           // Programming language for syntax highlighting
  hunks?: DiffHunk[];         // Individual diff hunks
  encoding?: string;          // File encoding
}

// Individual diff hunk information
export interface DiffHunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  header: string;             // Hunk header line
  changes: DiffChange[];      // Individual line changes
  metadata?: {
    linesAdded: number;
    linesRemoved: number;
    linesContext: number;
  };
}

// Individual line change in a diff
export interface DiffChange {
  type: 'add' | 'remove' | 'context';
  line: string;
  oldLineNumber?: number;     // Line number in old file
  newLineNumber?: number;     // Line number in new file
  content: string;            // Raw line content without prefix
}

// Enhanced resource metadata
export interface ResourceMetadata {
  size?: number;              // File size in bytes
  encoding?: string;          // File encoding (utf-8, etc.)
  language?: string;          // Programming language
  lastModified?: string;      // ISO timestamp of last modification
  permissions?: string;       // File permissions (Unix style)
  checksum?: string;          // File checksum/hash
}

// Streaming content support
export interface StreamingUpdate {
  toolCallId: string;
  chunk: string;              // Incremental content chunk
  chunkIndex: number;         // Sequential chunk number
  isComplete?: boolean;       // True if this is the final chunk
  metadata?: {
    totalSize?: number;       // Expected total size if known
    progress?: number;        // Progress percentage (0-100)
    estimatedTimeRemaining?: number; // Milliseconds
  };
}

// Tool call batching support
export interface ToolCallBatch {
  batchId: string;
  toolCalls: BatchedToolCall[];
  batchType: 'parallel' | 'sequential';
  metadata?: {
    totalOperations: number;
    completedOperations: number;
    failedOperations: number;
  };
}

export interface BatchedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  output?: string;
  error?: string;
  dependsOn?: string[];       // IDs of tool calls this depends on
}

// Enhanced content block types for multimedia support
export interface ImageContentBlock {
  type: "image";
  source: {
    type: "base64" | "url" | "file";
    media_type: string; // MIME type like "image/png", "image/jpeg"
    data?: string; // base64 data for base64 type
    url?: string; // URL for url type
    file_path?: string; // file path for file type
  };
  alt_text?: string;
  metadata?: Record<string, unknown>;
}

export interface AudioContentBlock {
  type: "audio";
  source: {
    type: "base64" | "url" | "file";
    media_type: string; // MIME type like "audio/mp3", "audio/wav"
    data?: string;
    url?: string;
    file_path?: string;
  };
  duration?: number; // Duration in seconds
  metadata?: Record<string, unknown>;
}

export interface ResourceContentBlock {
  type: "resource";
  uri: string; // file:// URI or other resource identifier
  mimeType?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface DiffContentBlock {
  type: "diff";
  old_content?: string;
  new_content: string;
  file_path?: string;
  language?: string; // Programming language for syntax highlighting
  metadata?: Record<string, unknown>;
}

// Union type for all enhanced content blocks
export type EnhancedContentBlock = 
  | ImageContentBlock 
  | AudioContentBlock 
  | ResourceContentBlock 
  | DiffContentBlock;

// Tool permission system types
export type PermissionLevel = "allow" | "deny" | "ask";

export interface ToolPermissionConfig {
  allowedTools?: string[]; // Explicit allow list
  disallowedTools?: string[]; // Explicit deny list
  toolPermissions?: Record<string, PermissionLevel>; // Per-tool permission levels
  defaultPermission?: PermissionLevel; // Default for unlisted tools
}

// Session listing types (custom ACP extension)
export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  lastAccessed: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  metadata: {
    userAgent?: string;
    version?: string;
    platform?: string;
    clientVersion?: string;
  };
  claudeSessionId?: string;
  status: "active" | "inactive" | "persisted";
}

export interface ListSessionsRequest {
  limit?: number;
  offset?: number;
  status?: "active" | "inactive" | "persisted" | "all";
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
}

// Zod validation schemas for runtime type checking
export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']);

export const SessionStatusSchema = z.enum(['active', 'inactive', 'persisted']);

export const SessionInfoSchema = z.object({
  sessionId: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastAccessed: z.string().datetime(),
  permissionMode: PermissionModeSchema,
  metadata: z.object({
    userAgent: z.string().optional(),
    version: z.string().optional(),
    platform: z.string().optional(),
    clientVersion: z.string().optional(),
  }),
  claudeSessionId: z.string().uuid().optional(),
  status: SessionStatusSchema,
});

export const ListSessionsRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  status: z.union([SessionStatusSchema, z.literal('all')]).optional(),
});

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionInfoSchema),
  total: z.number().int().min(0),
  hasMore: z.boolean(),
});

// Common validation schemas
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

// Validation helper functions - these perform basic validation and return the original types
export function validateListSessionsRequest(data: unknown): ListSessionsRequest {
  return ListSessionsRequestSchema.parse(data);
}

export function validateSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('sessionId must be a non-empty string');
  }
  return sessionId;
}

export function validateNewSessionRequest(data: unknown): NewSessionRequest {
  if (!data || typeof data !== 'object') {
    throw new Error('NewSessionRequest must be an object');
  }
  const req = data as Record<string, unknown>;
  if (!req.cwd || typeof req.cwd !== 'string' || req.cwd.trim().length === 0) {
    throw new Error('cwd must be a non-empty string');
  }
  return data as NewSessionRequest;
}

export function validateLoadSessionRequest(data: unknown): LoadSessionRequest {
  if (!data || typeof data !== 'object') {
    throw new Error('LoadSessionRequest must be an object');
  }
  const req = data as Record<string, unknown>;
  if (!req.sessionId || typeof req.sessionId !== 'string' || req.sessionId.trim().length === 0) {
    throw new Error('sessionId must be a non-empty string');
  }
  if (!req.cwd || typeof req.cwd !== 'string' || req.cwd.trim().length === 0) {
    throw new Error('cwd must be a non-empty string');
  }
  return data as LoadSessionRequest;
}

export function validatePromptRequest(data: unknown): PromptRequest {
  if (!data || typeof data !== 'object') {
    throw new Error('PromptRequest must be an object');
  }
  const req = data as Record<string, unknown>;
  if (!req.sessionId || typeof req.sessionId !== 'string' || req.sessionId.trim().length === 0) {
    throw new Error('sessionId must be a non-empty string');
  }
  if (!req.prompt || !Array.isArray(req.prompt) || req.prompt.length === 0) {
    throw new Error('prompt must be a non-empty array');
  }
  return data as PromptRequest;
}

// MIME type mappings for content detection
export const MIME_TYPE_MAPPINGS: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  
  // Code files (for syntax highlighting)
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".py": "text/python",
  ".java": "text/java",
  ".cpp": "text/cpp",
  ".c": "text/c",
  ".h": "text/c",
  ".css": "text/css",
  ".html": "text/html",
  ".xml": "text/xml",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".md": "text/markdown",
  ".txt": "text/plain",
};
