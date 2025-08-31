// Re-export all types from the agent-client-protocol
export * from "@zed-industries/agent-client-protocol";

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
