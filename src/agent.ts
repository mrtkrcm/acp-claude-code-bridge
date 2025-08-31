import { query } from "@anthropic-ai/claude-code";
import type { SDKMessage } from "@anthropic-ai/claude-code";
import {
  Agent,
  Client,
  PROTOCOL_VERSION,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  AuthenticateRequest,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  LoadSessionRequest,
  ClientCapabilities,
  ReadTextFileRequest,
  WriteTextFileRequest,
  RequestPermissionRequest,
  PermissionOption,
} from "@zed-industries/agent-client-protocol";
import type { 
  ClaudeMessage, 
  ClaudeStreamEvent, 
  ToolPermissionConfig,
  PermissionLevel,
  ExtendedClientCapabilities,
  ToolExecutionTiming,
  DiffMetadata,
  DiffHunk,
  DiffChange,
  ResourceMetadata,
  ToolCallBatch
} from "./types.js";
import { MIME_TYPE_MAPPINGS } from "./types.js";
import { ContextMonitor } from "./context-monitor.js";
import { SessionPersistenceManager, getDefaultPersistenceManager } from "./session-persistence.js";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

interface AgentSession {
  pendingPrompt: AsyncIterableIterator<SDKMessage> | null;
  abortController: AbortController | null;
  claudeSessionId?: string; // Claude's actual session_id, obtained after first message
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"; // Permission mode for this session
  toolPermissions?: ToolPermissionConfig; // Per-session tool permissions
  [key: string]: unknown; // Allow dynamic properties for warnings
}

export class ClaudeACPAgent implements Agent {
  private sessions: Map<string, AgentSession> = new Map();
  private contextMonitor: ContextMonitor;
  private DEBUG = process.env.ACP_DEBUG === "true";
  private fileLogger: NodeJS.WritableStream | null = null;
  private maxTurns: number;
  private defaultPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  private pathToClaudeCodeExecutable: string | undefined;
  private clientCapabilities: ClientCapabilities = {};
  private extendedClientCapabilities: ExtendedClientCapabilities = {};
  private toolExecutionTiming: Map<string, ToolExecutionTiming> = new Map();
  private streamingUpdates: Map<string, { chunks: string[]; totalSize?: number }> = new Map();
  private activeBatches: Map<string, ToolCallBatch> = new Map();
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_MS = 1000;
  private sessionPersistence: SessionPersistenceManager;
  private toolPermissions: ToolPermissionConfig = { defaultPermission: "allow" };

  private static validateConfig() {
    const maxTurns = process.env.ACP_MAX_TURNS;
    if (maxTurns && !/^\d+$/.test(maxTurns)) {
      throw new Error(`Invalid ACP_MAX_TURNS: "${maxTurns}" must be a positive integer`);
    }

    const permissionMode = process.env.ACP_PERMISSION_MODE;
    if (permissionMode && !["default", "acceptEdits", "bypassPermissions", "plan"].includes(permissionMode)) {
      throw new Error(`Invalid ACP_PERMISSION_MODE: "${permissionMode}". Must be one of: default, acceptEdits, bypassPermissions, plan`);
    }
  }

  constructor(private client: Client) {
    // Validate configuration before initialization
    ClaudeACPAgent.validateConfig();

    // Initialize configuration with validation
    this.maxTurns = this.parseMaxTurns();
    this.defaultPermissionMode = this.parsePermissionMode();
    this.pathToClaudeCodeExecutable = process.env.ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE;
    
    this.contextMonitor = new ContextMonitor(this.DEBUG);
    this.sessionPersistence = getDefaultPersistenceManager();
    this.initializeLogging();
    
    this.log(`Initialized ACP Agent - Max turns: ${this.maxTurns === 0 ? 'unlimited' : this.maxTurns}, Permission: ${this.defaultPermissionMode}`, 'INFO', {
      maxTurns: this.maxTurns,
      permissionMode: this.defaultPermissionMode,
      debugMode: this.DEBUG
    });
    
    // Enhanced session cleanup with logging
    setInterval(() => {
      const cleanedCount = this.contextMonitor.cleanupOldSessions();
      if (cleanedCount > 0) {
        this.log(`Cleaned up ${cleanedCount} old context sessions`, 'DEBUG');
      }
      
      // Also cleanup orphaned agent sessions
      this.cleanupOrphanedSessions();
    }, 60 * 60 * 1000);
  }

  private parseMaxTurns(): number {
    const value = process.env.ACP_MAX_TURNS;
    if (!value) return 100; // Default
    
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 0) {
      throw new Error(`Invalid ACP_MAX_TURNS: "${value}" must be a non-negative integer`);
    }
    
    return parsed;
  }

  private parsePermissionMode(): "default" | "acceptEdits" | "bypassPermissions" | "plan" {
    const mode = process.env.ACP_PERMISSION_MODE as "default" | "acceptEdits" | "bypassPermissions" | "plan";
    return mode || "default";
  }

  private detectExtendedCapabilities(params: InitializeRequest): ExtendedClientCapabilities {
    const capabilities = params.clientCapabilities || {};
    const experimental: ExtendedClientCapabilities['experimental'] = {};
    
    // Detect enhanced content support
    // Assume support if client has file system capabilities
    if (capabilities.fs?.readTextFile || capabilities.fs?.writeTextFile) {
      experimental.enhancedContent = true;
    }
    
    // Detect timing support
    // Always enable for now - it's just metadata
    experimental.toolTiming = true;
    
    // Detect progress updates support
    // Always enable - uses standard session updates
    experimental.progressUpdates = true;
    
    // Detect rich diff support
    // Enable if we have enhanced content support
    experimental.richDiffs = experimental.enhancedContent;
    
    // Detect resource metadata support
    // Enable if we have file system access
    experimental.resourceMetadata = !!capabilities.fs;
    
    // Detect streaming content support
    // Enable for clients that support session updates (all ACP clients do)
    experimental.streamingContent = true;
    
    // Detect tool call batching support
    // Enable for clients that support multiple tool calls
    experimental.toolCallBatching = true;
    
    return { experimental };
  }

  private startToolTiming(toolCallId: string, toolName?: string): void {
    if (!this.extendedClientCapabilities.experimental?.toolTiming) return;
    
    this.toolExecutionTiming.set(toolCallId, {
      startTime: Date.now(),
      estimatedDuration: this.estimateToolDuration(toolName),
    });
  }

  private completeToolTiming(toolCallId: string): ToolExecutionTiming | undefined {
    if (!this.extendedClientCapabilities.experimental?.toolTiming) return undefined;
    
    const timing = this.toolExecutionTiming.get(toolCallId);
    if (!timing) return undefined;
    
    const endTime = Date.now();
    timing.endTime = endTime;
    timing.duration = endTime - timing.startTime;
    
    this.toolExecutionTiming.delete(toolCallId);
    return timing;
  }

  private estimateToolDuration(toolName?: string): number | undefined {
    if (!toolName) return undefined;
    
    // Rough estimates in milliseconds based on tool type
    switch (toolName.toLowerCase()) {
      case 'read':
      case 'ls':
      case 'glob':
        return 500;
      case 'write':
      case 'edit':
        return 1000;
      case 'multiedit':
        return 2000;
      case 'bash':
        return 3000;
      case 'webfetch':
      case 'websearch':
        return 5000;
      default:
        // MCP tools
        if (toolName.startsWith('mcp__')) {
          return 2000;
        }
        return 1500;
    }
  }

  private initializeLogging(): void {
    const LOG_FILE = process.env.ACP_LOG_FILE;
    if (!LOG_FILE) return;

    try {
      const logPath = resolve(LOG_FILE);
      this.fileLogger = createWriteStream(logPath, { flags: 'a' });
      this.fileLogger.on('error', (error) => {
        console.error(`[ClaudeACPAgent] Log file error: ${error.message}`);
        this.fileLogger = null; // Disable file logging on error
      });
    } catch (error) {
      console.error(`[ClaudeACPAgent] Failed to create log file ${LOG_FILE}: ${error}`);
    }
  }

  private log(message: string, levelOrArgs?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | unknown, context?: Record<string, unknown>, ...args: unknown[]) {
    // Handle both old and new calling conventions
    let level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' = 'DEBUG';
    let allArgs = args;
    
    if (typeof levelOrArgs === 'string' && ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(levelOrArgs)) {
      level = levelOrArgs as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    } else if (levelOrArgs !== undefined) {
      // Old style call - levelOrArgs is actually an argument
      allArgs = [levelOrArgs, ...args];
    }
    const timestamp = new Date().toISOString();
    
    // Structured logging format
    const logEntry = {
      timestamp,
      level,
      component: 'ClaudeACPAgent',
      message,
      context: context || {},
      args: allArgs.length > 0 ? allArgs.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)) : undefined
    };
    
    const formattedMessage = `[${timestamp}] [${level}] [ClaudeACPAgent] ${message}`;
    const argsStr = allArgs.length > 0 ? ` ${logEntry.args!.join(' ')}` : '';
    
    // Console output based on level and debug setting
    if (this.DEBUG || level !== 'DEBUG') {
      const consoleMethod = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      consoleMethod(formattedMessage + argsStr);
    }
    
    // Structured file logging
    if (this.fileLogger) {
      this.fileLogger.write(JSON.stringify(logEntry) + '\n');
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.log(`Initialize with protocol version: ${params.protocolVersion}`, 'DEBUG');
    this.log(`Client capabilities: ${JSON.stringify(params.clientCapabilities || {})}`, 'DEBUG');

    // Store client capabilities for direct operations
    this.clientCapabilities = params.clientCapabilities || {};
    
    // Detect extended experimental capabilities
    this.extendedClientCapabilities = this.detectExtendedCapabilities(params);
    this.log(`Extended capabilities: ${JSON.stringify(this.extendedClientCapabilities)}`, 'DEBUG');
    
    this.log(`File system capabilities: readTextFile=${this.clientCapabilities.fs?.readTextFile}, writeTextFile=${this.clientCapabilities.fs?.writeTextFile}`);
    this.log(`Permission system: ACP supports native permission dialogs=${!!this.client.requestPermission}`, 'DEBUG');

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true, // Enable session loading
      },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.log("Creating new session", 'INFO');

    // Create a session ID with timestamp for better uniqueness
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2);
    const sessionId = `${timestamp}-${random}`;

    const sessionData = {
      pendingPrompt: null,
      abortController: null,
      claudeSessionId: undefined, // Will be set after first message
      permissionMode: this.defaultPermissionMode,
    };

    this.sessions.set(sessionId, sessionData);
    
    // Persist session metadata
    try {
      await this.sessionPersistence.saveSession({
        sessionId,
        permissionMode: this.defaultPermissionMode,
        createdAt: new Date().toISOString(),
        metadata: {
          userAgent: 'ACP-Claude-Code-Bridge',
          version: '0.5.4'
        }
      });
    } catch (error) {
      this.log(`Failed to persist session metadata: ${error}`, 'WARN', { sessionId });
    }

    this.log(`Created session: ${sessionId}`, 'INFO', { sessionId, permissionMode: this.defaultPermissionMode });

    return {
      sessionId,
    };
  }

  async loadSession?(params: LoadSessionRequest): Promise<void> {
    this.log(`Loading session: ${params.sessionId}`, 'INFO', { sessionId: params.sessionId });

    // Check if we already have this session in memory
    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      this.log(
        `Session ${params.sessionId} already exists in memory with Claude session_id: ${existingSession.claudeSessionId}`,
        'DEBUG',
        { sessionId: params.sessionId, claudeSessionId: existingSession.claudeSessionId }
      );
      return;
    }

    // Try to load session from persistent storage
    try {
      const persistedSession = await this.sessionPersistence.loadSession(params.sessionId);
      
      if (persistedSession) {
        this.log(`Loaded session from persistence: ${params.sessionId}`, 'INFO', {
          sessionId: params.sessionId,
          claudeSessionId: persistedSession.claudeSessionId,
          permissionMode: persistedSession.permissionMode,
          createdAt: persistedSession.createdAt
        });
        
        // Restore session state from persistence
        this.sessions.set(params.sessionId, {
          pendingPrompt: null,
          abortController: null,
          claudeSessionId: persistedSession.claudeSessionId,
          permissionMode: (persistedSession.permissionMode as typeof this.defaultPermissionMode) || this.defaultPermissionMode,
        });
        
        // Restore context stats if available
        if (persistedSession.contextStats) {
          // Note: This would require expanding ContextMonitor to support restoration
          this.log(`Context stats available for restoration`, 'DEBUG', {
            sessionId: params.sessionId,
            tokens: persistedSession.contextStats.estimatedTokens,
            messages: persistedSession.contextStats.messages
          });
        }
        
        return;
      }
    } catch (error) {
      this.log(`Failed to load session from persistence: ${error}`, 'WARN', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Create a new session entry if not found in persistence
    // This handles the case where the agent restarts but Zed still has the session ID
    this.sessions.set(params.sessionId, {
      pendingPrompt: null,
      abortController: null,
      claudeSessionId: undefined,
      permissionMode: this.defaultPermissionMode,
    });

    this.log(
      `Created new session entry for loaded session: ${params.sessionId}`,
      'INFO',
      { sessionId: params.sessionId, permissionMode: this.defaultPermissionMode }
    );
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    this.log("Authenticate called", 'DEBUG');
    // Claude Code SDK handles authentication internally through ~/.claude/config.json
    // Users should run `claude setup-token` or login through the CLI
    this.log("Using Claude Code authentication from ~/.claude/config.json", 'DEBUG');
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const currentSessionId = params.sessionId;
    const session = this.sessions.get(currentSessionId);

    if (!session) {
      this.log(
        `Session ${currentSessionId} not found in map. Available sessions: ${Array.from(this.sessions.keys()).join(", ")}`,
      );
      this.log(`Available context sessions: ${Array.from(this.contextMonitor.getAllStats().keys()).join(", ")}`);
      throw new Error(`Session ${currentSessionId} not found`);
    }

    this.log(`Processing prompt for session: ${currentSessionId}`, 'DEBUG');
    this.log(
      `Session state: claudeSessionId=${session.claudeSessionId}, pendingPrompt=${!!session.pendingPrompt}, abortController=${!!session.abortController}`,
    );
    this.log(
      `Available sessions: ${Array.from(this.sessions.keys()).join(", ")}`,
    );

    // Cancel any pending prompt
    if (session.abortController) {
      session.abortController.abort();
    }

    session.abortController = new AbortController();

    try {
      // Convert prompt content blocks to a single string
      const promptText = params.prompt
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("");

      this.log(
        `Prompt received (${promptText.length} chars): ${promptText.substring(0, 100)}...`,
      );
      
      // Track context usage for user message
      const contextWarning = this.contextMonitor.trackMessage(currentSessionId, promptText, 'user');
      if (contextWarning) {
        this.log(`Context warning: ${contextWarning.message}`, 'DEBUG');
        
        // Send context status as a subtle message to user with enhanced formatting
        if (contextWarning.level === 'critical') {
          await this.client.sessionUpdate({
            sessionId: currentSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `🚨 **Context Alert**: ${contextWarning.message}\n💡 ${contextWarning.recommendation || 'Consider starting a new session.'}\n\n`,
              },
            },
          });
        } else if (contextWarning.level === 'warning') {
          // Show warning level notifications too, but less prominently
          await this.client.sessionUpdate({
            sessionId: currentSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `⚠️ ${contextWarning.message}\n`,
              },
            },
          });
        }
      }

      // Use simple string prompt - Claude SDK will handle history with resume
      const queryInput = promptText;

      if (!session.claudeSessionId) {
        this.log("First message for this session, no resume");
      } else {
        this.log(`Resuming Claude session: ${session.claudeSessionId}`, 'DEBUG');
      }

      // Check for permission mode hints in the prompt
      let permissionMode = session.permissionMode || this.defaultPermissionMode;

      // Allow dynamic permission mode switching via special commands
      if (promptText.includes("[ACP:PERMISSION:ACCEPT_EDITS]")) {
        permissionMode = "acceptEdits";
        session.permissionMode = "acceptEdits";
      } else if (promptText.includes("[ACP:PERMISSION:BYPASS]")) {
        permissionMode = "bypassPermissions";
        session.permissionMode = "bypassPermissions";
      } else if (promptText.includes("[ACP:PERMISSION:DEFAULT]")) {
        permissionMode = "default";
        session.permissionMode = "default";
      }

      this.log(`Using permission mode: ${permissionMode}`, 'DEBUG');

      // Start Claude query with configurable turn limit (0 = unlimited)
      const queryOptions: Record<string, unknown> = {
        permissionMode,
        pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
        resume: session.claudeSessionId || undefined,
      };
      
      // Only set maxTurns if not unlimited (0)
      if (this.maxTurns > 0) {
        queryOptions.maxTurns = this.maxTurns;
      }
      
      // Tool permissions can be updated via updateToolPermissions() method calls
      
      this.log(`Starting query with${this.maxTurns === 0 ? ' unlimited' : ` ${this.maxTurns}`} turns`, 'DEBUG');
      
      const messages = query({
        prompt: queryInput,
        options: queryOptions,
      });

      session.pendingPrompt = messages as AsyncIterableIterator<SDKMessage>;

      // Process messages and send updates
      let messageCount = 0;
      let turnCount = 0;

      for await (const message of messages) {
        if (session.abortController?.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        messageCount++;
        const sdkMessage = message as SDKMessage;
        
        // Count turns (assistant messages that aren't system)
        if (sdkMessage.type === 'assistant') {
          turnCount++;
          
          // Warn when approaching turn limit (only if limit is set)
          if (this.maxTurns > 0) {
            const warningThreshold = Math.max(10, this.maxTurns * 0.8);
            if (turnCount >= warningThreshold && turnCount < this.maxTurns) {
              this.log(`Turn warning: ${turnCount}/${this.maxTurns} turns used`, 'DEBUG');
              
              // Send warning to user (only once per session)
              const warningKey: string = `turn_warning_${session.claudeSessionId}`;
              if (!(warningKey in session)) {
                session[warningKey] = true;
                
                await this.client.sessionUpdate({
                  sessionId: currentSessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: `\n📊 Turn usage: ${turnCount}/${this.maxTurns} turns used. Continuing analysis...\n\n`,
                    },
                  },
                });
              }
            }
          } else if (turnCount % 50 === 0 && turnCount > 0) {
            // Log progress for unlimited sessions every 50 turns
            this.log(`Unlimited session progress: ${turnCount} turns completed`, 'DEBUG');
          }
        }
        
        this.log(
          `Processing message #${messageCount} (turn ${turnCount}) of type: ${sdkMessage.type}`,
        );

        // Extract and store Claude's session_id from any message that has it
        if (
          "session_id" in sdkMessage &&
          typeof sdkMessage.session_id === "string" &&
          sdkMessage.session_id
        ) {
          if (session.claudeSessionId !== sdkMessage.session_id) {
            this.log(
              `Updating Claude session_id from ${session.claudeSessionId} to ${sdkMessage.session_id}`,
            );
            session.claudeSessionId = sdkMessage.session_id;
            // Update the session in the map to ensure persistence
            this.sessions.set(currentSessionId, session);
          }
        }

        // Log message type and content for debugging
        if (sdkMessage.type === "user") {
          this.log(`Processing user message`, 'DEBUG');
        } else if (sdkMessage.type === "assistant") {
          this.log(`Processing assistant message`, 'DEBUG');
          // Log assistant message content for debugging
          if ("message" in sdkMessage && sdkMessage.message) {
            const assistantMsg = sdkMessage.message as {
              content?: Array<{ type: string; text?: string }>;
            };
            if (assistantMsg.content) {
              this.log(
                `Assistant content: ${JSON.stringify(assistantMsg.content).substring(0, 200)}`,
              );
            }
          }
        }

        await this.handleClaudeMessage(
          currentSessionId,
          message as ClaudeMessage,
        );
      }

      this.log(`Processed ${messageCount} messages total`, 'DEBUG');
      this.log(`Final Claude session_id: ${session.claudeSessionId}`, 'DEBUG');
      session.pendingPrompt = null;

      // Ensure the session is properly saved with the Claude session_id
      this.sessions.set(currentSessionId, session);

      return {
        stopReason: "end_turn",
      };
    } catch (error) {
      this.log("Error during prompt processing:", error);
      
      // Enhanced error logging with context
      const contextStats = this.contextMonitor.getStats(currentSessionId);
      if (contextStats) {
        this.log(`Error occurred at context usage: ${(contextStats.usage * 100).toFixed(1)}%`, 'DEBUG');
      }

      if (session.abortController?.signal.aborted) {
        return { stopReason: "cancelled" };
      }

      // Send enhanced error information to client
      const errorMessage = error instanceof Error ? error.message : String(error);
      const contextInfo = contextStats ? ` (Context: ${(contextStats.usage * 100).toFixed(1)}%)` : '';
      
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `❌ **Error**: ${errorMessage}${contextInfo}\n\n*If this persists, try starting a new session.*`,
          },
        },
      });

      return {
        stopReason: "end_turn",
      };
    } finally {
      session.pendingPrompt = null;
      session.abortController = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.log(`Cancel requested for session: ${params.sessionId}`, 'DEBUG');

    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.abortController?.abort();

      if (session.pendingPrompt && session.pendingPrompt.return) {
        await session.pendingPrompt.return();
        session.pendingPrompt = null;
      }
    }
  }

  private async handleClaudeMessage(
    sessionId: string,
    message: ClaudeMessage | SDKMessage,
  ): Promise<void> {
    // Use a more flexible type handling approach
    const msg = message as ClaudeMessage;
    const messageType = "type" in message ? message.type : undefined;
    this.log(
      `Handling message type: ${messageType}`,
      JSON.stringify(message).substring(0, 200),
    );

    switch (messageType) {
      case "system":
        // System messages are internal, don't send to client
        break;

      case "user":
        // Handle user message that may contain tool results
        if (msg.message && msg.message.content) {
          for (const content of msg.message.content) {
            if (content.type === "tool_result") {
              this.log(`Tool result received for: ${content.tool_use_id}`, 'DEBUG');
              
              // Send tool_call_update with completed status
              await this.client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: content.tool_use_id || "",
                  status: "completed",
                  content: [
                    {
                      type: "content",
                      content: {
                        type: "text",
                        text: (content.content || "") + "\n",
                      },
                    },
                  ],
                  rawOutput: content.content ? { output: content.content } : undefined,
                },
              });
            }
          }
        }
        break;

      case "assistant":
        // Handle assistant message from Claude
        if (msg.message && msg.message.content) {
          for (const content of msg.message.content) {
            if (content.type === "text") {
              const text = content.text || "";
              
              // Track context usage for assistant message with enhanced monitoring
              const assistantContextWarning = this.contextMonitor.trackMessage(sessionId, text, 'assistant');
              if (assistantContextWarning && assistantContextWarning.level === 'critical') {
                this.log(`Critical context usage detected: ${assistantContextWarning.message}`, 'DEBUG');
                // Could notify user here if needed, but avoid interrupting the flow
              }
              
              // Send text content without adding extra newlines
              // Claude already formats the text properly
              await this.client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: text,
                  },
                },
              });
            } else if (content.type === "tool_use") {
              // Handle tool_use blocks in assistant messages
              this.log(
                `Tool use block in assistant message: ${content.name}, id: ${content.id}`,
              );

              // Send tool_call notification to client with enhanced title
              const toolTitle = this.getEnhancedToolTitle(content.name || "Tool", content.input);
              
              // Start timing for this tool call
              this.startToolTiming(content.id || "", content.name);
              
              await this.client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: content.id || "",
                  title: toolTitle,
                  kind: this.mapToolKind(content.name || ""),
                  status: "pending",
                  rawInput: content.input as Record<string, unknown>,
                  ...(this.extendedClientCapabilities.experimental?.toolTiming && {
                    metadata: {
                      timing: this.toolExecutionTiming.get(content.id || ""),
                    },
                  }),
                },
              });

              // If this is TodoWrite, format the todos nicely
              if (content.name === "TodoWrite" && content.input?.todos) {
                const todos = content.input.todos as Array<{
                  content: string;
                  status: string;
                  activeForm: string;
                }>;
                let todoText = "📝 Todo List:\n";
                todos.forEach((todo, index) => {
                  const statusEmoji =
                    todo.status === "completed"
                      ? "✅"
                      : todo.status === "in_progress"
                        ? "🔄"
                        : "⏳";
                  todoText += `${index + 1}. ${statusEmoji} ${todo.content}\n`;
                });

                await this.client.sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: todoText + "\n",
                    },
                  },
                });
              }
            }
          }
        } else if ("text" in msg && typeof msg.text === "string") {
          // Handle direct text in assistant message
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: msg.text,
              },
            },
          });
        }
        break;

      case "result":
        // Result message indicates completion
        this.log("Query completed with result:", msg.result);
        break;

      case "text":
        // Direct text messages - preserve formatting without extra newlines
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: msg.text || "",
            },
          },
        });
        break;

      case "tool_use_start": {
        // Log the tool call details for debugging
        this.log(`Tool call started: ${msg.tool_name}`, `ID: ${msg.id}`);

        // Handle tool input - ensure it's a proper object
        const input = msg.input || {};

        // Log the input for debugging
        if (this.DEBUG) {
          try {
            this.log(`Tool input:`, JSON.stringify(input, null, 2));

            // Special logging for content field
            if (input && typeof input === "object" && "content" in input) {
              const content = (input as Record<string, unknown>).content;
              if (typeof content === "string") {
                const preview = content.substring(0, 100);
                this.log(
                  `Content preview: ${preview}${content.length > 100 ? "..." : ""}`,
                );
              }
            }
          } catch (e) {
            this.log("Error logging input:", e);
          }
        }

        // Try to handle direct file operations through ACP
        const directOperationResult = await this.tryDirectFileOperation(
          sessionId,
          msg.tool_name || "",
          msg.id || "",
          input
        );
        
        // If direct operation was handled, don't proceed with normal tool call flow
        if (directOperationResult) {
          break;
        }

        // First check if tool is allowed to execute at all
        const toolPermission = this.getToolPermissionLevel(msg.tool_name || "");
        
        if (toolPermission === 'deny' || !this.isToolAllowed(msg.tool_name || "")) {
          // Tool is not allowed, send denial notification
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: msg.id || "",
              status: "failed",
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Tool "${msg.tool_name}" is not allowed by current permission configuration.`,
                  },
                },
              ],
              rawOutput: { permission: 'denied', reason: 'tool_not_allowed', toolName: msg.tool_name },
            },
          });
          break; // Don't proceed with tool execution
        }
        
        // Check if we should request permission for this tool operation
        const shouldRequestPermission = await this.shouldRequestPermissionForTool(
          sessionId,
          msg.tool_name || "",
          input
        );

        if (shouldRequestPermission) {
          // Create tool call for permission request (not ToolCallUpdate)
          const toolTitle = this.getEnhancedToolTitle(msg.tool_name || "Tool", input);
          const toolCall = {
            title: toolTitle,
            kind: this.mapToolKind(msg.tool_name || ""),
            status: "pending" as const,
            toolCallId: msg.id || "",
            content: [
              {
                type: "content" as const,
                content: {
                  type: "text" as const,
                  text: this.getToolDescription(msg.tool_name || "", input),
                },
              },
            ],
          };

          const permission = await this.requestUserPermission(
            sessionId,
            `execute ${msg.tool_name}`,
            toolCall,
            this.getToolDescription(msg.tool_name || "", input)
          );

          if (permission !== 'allowed') {
            // Send permission denied notification and skip tool execution
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call" as const,
                toolCallId: msg.id || "",
                title: toolTitle,
                kind: this.mapToolKind(msg.tool_name || ""),
                status: "pending" as const,
                rawInput: input as Record<string, unknown>,
              },
            });

            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call_update" as const,
                toolCallId: msg.id || "",
                status: "failed" as const,
                content: [
                  {
                    type: "content" as const,
                    content: {
                      type: "text",
                      text: `Permission ${permission} for ${msg.tool_name} operation`,
                    },
                  },
                ],
                rawOutput: { permission, operation: msg.tool_name },
              },
            });
            break; // Don't proceed with tool execution
          }
        }

        // Enhanced tool call with descriptive title and location
        const toolTitle = this.getEnhancedToolTitle(msg.tool_name || "Tool", input);
        const toolLocation = this.getToolLocation(msg.tool_name || "Tool", input);
        
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call" as const,
            toolCallId: msg.id || "",
            title: toolTitle,
            kind: this.mapToolKind(msg.tool_name || ""),
            status: "pending" as const,
            rawInput: input as Record<string, unknown>,
          },
        });
        
        // Log location if available
        if (toolLocation) {
          this.log(`Tool location: ${toolLocation.path}${toolLocation.line ? `:${toolLocation.line}` : ''}`, 'DEBUG');
        }

        // For TodoWrite tool, also send formatted todo list as text
        if (
          msg.tool_name === "TodoWrite" &&
          input &&
          typeof input === "object" &&
          "todos" in input
        ) {
          const todos = (
            input as {
              todos: Array<{
                content: string;
                status: string;
                activeForm: string;
              }>;
            }
          ).todos;
          if (todos && Array.isArray(todos)) {
            let todoText = "\n📝 Todo List Update:\n";
            todos.forEach((todo, index) => {
              const statusEmoji =
                todo.status === "completed"
                  ? "✅"
                  : todo.status === "in_progress"
                    ? "🔄"
                    : "⏳";
              todoText += `  ${index + 1}. ${statusEmoji} ${todo.content}\n`;
            });

            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: todoText,
                },
              },
            });
          }
        }
        break;
      }

      case "tool_use_output": {
        const outputText = msg.output || "";

        // Log the tool output for debugging
        this.log(`Tool call completed: ${msg.id}`, 'DEBUG');
        this.log(`Tool output length: ${outputText.length} characters`, 'DEBUG');

        // Process content and detect multimedia/enhanced content
        const enhancedContent = await this.processToolOutputContent(outputText, msg.tool_name);

        // Complete timing for this tool call
        const timing = this.completeToolTiming(msg.id || "");

        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: msg.id || "",
            status: "completed",
            content: enhancedContent,
            // Pass output directly without extra wrapping
            rawOutput: msg.output ? { output: outputText } : undefined,
            ...(timing && this.extendedClientCapabilities.experimental?.toolTiming && {
              metadata: {
                timing,
              },
            }),
          },
        });
        break;
      }

      case "tool_use_error":
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: msg.id || "",
            status: "failed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: `Error: ${msg.error}`,
                },
              },
            ],
            rawOutput: { error: msg.error },
          },
        });
        break;

      case "stream_event": {
        // Handle stream events if needed
        const event = msg.event as ClaudeStreamEvent;
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "text"
        ) {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: event.content_block.text || "",
              },
            },
          });
        } else if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        ) {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: event.delta.text || "",
              },
            },
          });
        } else if (event.type === "content_block_stop") {
          // Content block ended - Claude handles its own formatting
          this.log("Content block stopped", 'DEBUG');
        }
        break;
      }

      default:
        this.log(
          `Unhandled message type: ${messageType}`,
          JSON.stringify(message).substring(0, 500),
        );
    }
  }

  /**
   * Enhanced permission system with better context awareness and fallback handling
   */
  private async requestUserPermission(
    sessionId: string,
    operation: string,
    toolCall: {
      title: string;
      kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
      status: "pending" | "in_progress" | "completed" | "failed";
      toolCallId: string;
      content: Array<{
        type: 'content';
        content: {
          type: 'text';
          text: string;
        };
      }>;
    },
    _description?: string
  ): Promise<'allowed' | 'denied' | 'cancelled'> {
    // Enhanced permission mode handling with better logging and context
    const session = this.sessions.get(sessionId);
    const permissionMode = session?.permissionMode || this.defaultPermissionMode;
    const contextStats = this.contextMonitor.getStats(sessionId);
    
    this.log(`Permission check for '${operation}' - Mode: ${permissionMode}, Context: ${contextStats ? (contextStats.usage * 100).toFixed(1) + '%' : 'N/A'}`);

    if (permissionMode === 'bypassPermissions') {
      this.log(`\u2705 Bypassing permission request for ${operation} (mode: ${permissionMode})`, 'DEBUG');
      return 'allowed';
    }

    if (permissionMode === 'acceptEdits') {
      // More granular control for acceptEdits mode
      if (toolCall.kind === 'execute' || operation.toLowerCase().includes('bash')) {
        this.log(`\u26a0\ufe0f Execute operation requires explicit permission even in acceptEdits mode`, 'DEBUG');
        // Continue to permission dialog
      } else {
        this.log(`\u2705 Auto-accepting ${toolCall.kind} operation: ${operation} (mode: ${permissionMode})`, 'DEBUG');
        return 'allowed';
      }
    }

    // Use ACP native permission dialog if available
    if (this.client.requestPermission) {
      this.log(`Requesting ACP permission for: ${operation}`, 'DEBUG');
      
      try {
        // Enhanced permission options based on operation type
        const options: PermissionOption[] = [
          {
            optionId: 'allow',
            name: 'Allow Once',
            kind: 'allow_once' as const,
          },
          {
            optionId: 'deny',
            name: 'Deny',
            kind: 'reject_once' as const,
          }
        ];
        
        // Add "Always Allow" option for safe operations
        if (toolCall.kind !== 'execute' && !operation.toLowerCase().includes('bash')) {
          options.push({
            optionId: 'always',
            name: `Always Allow ${toolCall.kind}`,
            kind: 'allow_always' as const,
          });
        }
        
        // Add session-specific options for power users
        if (toolCall.kind === 'edit' || toolCall.kind === 'read') {
          options.push({
            optionId: 'session',
            name: 'Allow for Session',
            kind: 'allow_always' as const, // Treated as always for this session
          });
        }

        const permissionRequest: RequestPermissionRequest = {
          sessionId,
          toolCall,
          options,
        };

        const response = await this.client.requestPermission(permissionRequest);
        
        if (response.outcome.outcome === 'cancelled') {
          this.log(`Permission request cancelled for: ${operation}`, 'DEBUG');
          return 'cancelled';
        } else if (response.outcome.outcome === 'selected') {
          const selectedOption = response.outcome.optionId;
          this.log(`Permission ${selectedOption} for: ${operation}`, 'DEBUG');
          
          // Enhanced permission mode updating based on user choice
          if (session) {
            if (selectedOption === 'always') {
              session.permissionMode = 'acceptEdits';
              this.log(`\u2699\ufe0f Updated session to acceptEdits mode for future ${toolCall.kind} operations`, 'DEBUG');
            } else if (selectedOption === 'session') {
              // Create a session-specific allowlist (extend AgentSession interface if needed)
              session.permissionMode = 'acceptEdits'; // For now, treat as acceptEdits
              this.log(`\ud83d\udcdd Session permission granted for ${toolCall.kind} operations`, 'DEBUG');
            }
          }
          
          const allowed = ['allow', 'always', 'session'].includes(selectedOption);
          this.log(`Permission ${allowed ? 'GRANTED' : 'DENIED'} for: ${operation}`, 'DEBUG');
          return allowed ? 'allowed' : 'denied';
        }
      } catch (error) {
        this.log(`ACP permission request failed: ${error}`, 'ERROR');
        // Fall through to default behavior
      }
    }

    // Fallback: Check permission mode for default behavior
    if (permissionMode === 'plan') {
      this.log(`Plan mode - denying ${operation} for review`, 'DEBUG');
      return 'denied';
    }

    // Default mode - allow (matches Claude's default behavior)
    this.log(`Default permission granted for: ${operation}`, 'DEBUG');
    return 'allowed';
  }

  /**
   * Attempts to handle file operations directly through ACP instead of Claude tools.
   * Returns true if the operation was handled directly, false if fallback to Claude tools is needed.
   */
  private async tryDirectFileOperation(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    input: unknown
  ): Promise<boolean> {
    if (!input || typeof input !== 'object' || input === null) {
      return false;
    }

    const inputObj = input as Record<string, unknown>;
    const lowerToolName = toolName.toLowerCase();

    try {
      // Handle Read operations with ACP readTextFile
      if (lowerToolName === 'read' && this.clientCapabilities.fs?.readTextFile && inputObj.file_path) {
        // Validate file path
        const filePath = String(inputObj.file_path).trim();
        if (!filePath || filePath.length === 0) {
          this.log(`Invalid file path for ACP readTextFile: "${filePath}"`, 'DEBUG');
          return false;
        }

        this.log(`Using ACP direct readTextFile for: ${filePath}`, 'DEBUG');

        // Create tool call for permission request
        const toolCall = {
          title: `Read: ${filePath.split('/').pop()}`,
          kind: "read" as const,
          status: "pending" as const,
          toolCallId,
          content: [
            {
              type: "content" as const,
              content: {
                type: "text" as const,
                text: `Read contents of ${filePath}`,
              },
            },
          ],
        };

        // Send tool call start notification
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call" as const,
            toolCallId,
            title: `Read: ${filePath.split('/').pop()}`,
            kind: "read" as const,
            status: "pending" as const,
            rawInput: inputObj,
          },
        });

        // Request permission for file read
        const permission = await this.requestUserPermission(
          sessionId,
          `read file ${filePath}`,
          toolCall,
          `Read contents of ${filePath}`
        );

        if (permission !== 'allowed') {
          // Send cancellation/denial notification
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update" as const,
              toolCallId,
              status: "failed" as const,
              content: [
                {
                  type: "content" as const,
                  content: {
                    type: "text",
                    text: `Permission ${permission} for reading ${filePath}`,
                  },
                },
              ],
              rawOutput: { permission, operation: 'read' },
            },
          });
          return true; // Handled, don't fall back
        }

        // Validate and prepare read parameters
        const readParams: ReadTextFileRequest = {
          sessionId,
          path: filePath,
        };

        // Add optional parameters with validation
        if (typeof inputObj.offset === 'number' && inputObj.offset >= 1) {
          readParams.line = inputObj.offset;
        }
        if (typeof inputObj.limit === 'number' && inputObj.limit > 0) {
          readParams.limit = inputObj.limit;
        }

        const response = await this.client.readTextFile(readParams);

        // Validate response
        if (!response || typeof response.content !== 'string') {
          throw new Error('Invalid response from ACP readTextFile');
        }

        // Send successful completion
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: response.content,
                },
              },
            ],
            rawOutput: { content: response.content, length: response.content.length },
          },
        });

        this.log(`ACP readTextFile completed: ${response.content.length} characters from ${filePath}`, 'DEBUG');
        return true;
      }

      // Handle Write operations with ACP writeTextFile  
      if (lowerToolName === 'write' && this.clientCapabilities.fs?.writeTextFile && inputObj.file_path && inputObj.content) {
        // Validate file path and content
        const filePath = String(inputObj.file_path).trim();
        const content = String(inputObj.content);
        
        if (!filePath || filePath.length === 0) {
          this.log(`Invalid file path for ACP writeTextFile: "${filePath}"`, 'DEBUG');
          return false;
        }

        this.log(`Using ACP direct writeTextFile for: ${filePath} (${content.length} chars)`, 'DEBUG');

        // Create tool call for permission request
        const toolCall = {
          title: `Write: ${filePath.split('/').pop()}`,
          kind: "edit" as const,
          status: "pending" as const,
          toolCallId,
          content: [
            {
              type: "content" as const,
              content: {
                type: "text" as const,
                text: `Write ${content.length} characters to ${filePath}`,
              },
            },
          ],
        };

        // Send tool call start notification
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call" as const,
            toolCallId,
            title: `Write: ${filePath.split('/').pop()}`,
            kind: "edit" as const,
            status: "pending" as const,
            rawInput: inputObj,
          },
        });

        // Request permission for file write (more sensitive operation)
        const permission = await this.requestUserPermission(
          sessionId,
          `write ${content.length} characters to ${filePath}`,
          toolCall,
          `Write ${content.length} characters to ${filePath}`
        );

        if (permission !== 'allowed') {
          // Send cancellation/denial notification
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update" as const,
              toolCallId,
              status: "failed" as const,
              content: [
                {
                  type: "content" as const,
                  content: {
                    type: "text",
                    text: `Permission ${permission} for writing to ${filePath}`,
                  },
                },
              ],
              rawOutput: { permission, operation: 'write' },
            },
          });
          return true; // Handled, don't fall back
        }

        const writeParams: WriteTextFileRequest = {
          sessionId,
          path: filePath,
          content: content,
        };

        await this.client.writeTextFile(writeParams);

        // Send successful completion
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: `Successfully wrote ${content.length} characters to ${filePath}`,
                },
              },
            ],
            rawOutput: { success: true, path: filePath, length: content.length },
          },
        });

        this.log(`ACP writeTextFile completed: ${content.length} characters to ${filePath}`, 'DEBUG');
        return true;
      }

    } catch (error) {
      this.log(`ACP direct file operation failed for ${toolName}: ${error}`, 'ERROR');
      
      try {
        // Send failure notification
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: `⚠️ ACP direct operation failed: ${error instanceof Error ? error.message : String(error)}.\nFalling back to Claude tools for compatibility.`,
                },
              },
            ],
            rawOutput: { 
              error: error instanceof Error ? error.message : String(error),
              fallback: true 
            },
          },
        });
      } catch (updateError) {
        this.log(`Failed to send error update: ${updateError}`, 'ERROR');
      }

      // Return false to indicate fallback to Claude tools is needed
      return false;
    }

    // Not a supported direct operation, fallback to Claude tools
    return false;
  }

  /**
   * Determines if we should request permission for a specific tool operation.
   * Based on permission mode, tool sensitivity, and tool permission configuration.
   */
  private async shouldRequestPermissionForTool(
    sessionId: string,
    toolName: string,
    _input: unknown
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const permissionMode = session?.permissionMode || this.defaultPermissionMode;

    // First check tool permissions configuration
    const toolPermission = this.getToolPermissionLevel(toolName);
    
    // If tool is explicitly denied, we should not execute it at all
    if (toolPermission === 'deny') {
      return true; // Return true to trigger permission request, which will deny
    }
    
    // If tool is explicitly allowed, skip permission unless in plan mode
    if (toolPermission === 'allow' && permissionMode !== 'plan') {
      return false;
    }
    
    // If tool permission is 'ask', always request permission
    if (toolPermission === 'ask') {
      return true;
    }

    // Skip permission requests in certain modes (for tools not explicitly configured)
    if (permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits') {
      return false;
    }

    // Always request permission in plan mode
    if (permissionMode === 'plan') {
      return true;
    }

    const lowerToolName = toolName.toLowerCase();
    
    // Sensitive operations that should always ask for permission
    const sensitiveTools = [
      'bash', 'execute', 'run',  // Command execution
      'write', 'edit', 'multiedit',  // File modification
      'delete', 'remove',  // File deletion
      'move', 'rename'  // File system changes
    ];

    return sensitiveTools.some(sensitive => lowerToolName.includes(sensitive));
  }

  /**
   * Get permission level for a specific tool
   */
  private getToolPermissionLevel(toolName: string): PermissionLevel {
    // Initialize toolPermissions if not set
    if (!this.toolPermissions) {
      this.toolPermissions = { defaultPermission: 'allow' };
    }
    
    // Check if tool is explicitly disallowed
    if (this.toolPermissions.disallowedTools?.includes(toolName)) {
      return 'deny';
    }
    
    // Check if tool is explicitly allowed (and allowed list exists)
    if (this.toolPermissions.allowedTools && this.toolPermissions.allowedTools.length > 0) {
      return this.toolPermissions.allowedTools.includes(toolName) ? 'allow' : 'deny';
    }
    
    // Check per-tool permissions
    if (this.toolPermissions.toolPermissions && toolName in this.toolPermissions.toolPermissions) {
      return this.toolPermissions.toolPermissions[toolName];
    }
    
    // Return default permission
    return this.toolPermissions.defaultPermission || 'allow';
  }

  /**
   * Gets a human-readable description of what a tool operation will do.
   */
  private getToolDescription(toolName: string, input: unknown): string {
    const lowerToolName = toolName.toLowerCase();
    
    if (!input || typeof input !== 'object' || input === null) {
      return `Execute ${toolName}`;
    }

    const inputObj = input as Record<string, unknown>;

    // Bash/Execute operations
    if (lowerToolName.includes('bash') || lowerToolName.includes('execute')) {
      if (inputObj.command && typeof inputObj.command === 'string') {
        const cmd = String(inputObj.command).substring(0, 50);
        return `Execute command: ${cmd}${cmd.length > 50 ? '...' : ''}`;
      }
      return `Execute shell command`;
    }

    // File operations
    if (lowerToolName.includes('write') || lowerToolName.includes('edit')) {
      if (inputObj.file_path) {
        const content = inputObj.content ? ` (${String(inputObj.content).length} chars)` : '';
        return `Modify file ${inputObj.file_path}${content}`;
      }
      return `Modify files`;
    }

    if (lowerToolName.includes('delete') || lowerToolName.includes('remove')) {
      if (inputObj.file_path || inputObj.path) {
        return `Delete ${inputObj.file_path || inputObj.path}`;
      }
      return `Delete files`;
    }

    if (lowerToolName.includes('move') || lowerToolName.includes('rename')) {
      if (inputObj.source && inputObj.destination) {
        return `Move ${inputObj.source} to ${inputObj.destination}`;
      }
      return `Move/rename files`;
    }

    return `Execute ${toolName}`;
  }

  private getEnhancedToolTitle(toolName: string, input?: unknown): string {
    const lowerName = toolName.toLowerCase();
    
    // Extract useful information from input for better titles
    if (input && typeof input === 'object' && input !== null) {
      const inputObj = input as Record<string, unknown>;
      
      // File operations - show filename
      if ((lowerName.includes('read') || lowerName.includes('write') || lowerName.includes('edit')) && inputObj.file_path) {
        const filename = String(inputObj.file_path).split('/').pop();
        return `${toolName}: ${filename}`;
      }
      
      // Search operations - show pattern
      if (lowerName.includes('grep') && inputObj.pattern) {
        return `${toolName}: "${inputObj.pattern}"`;
      }
      
      // Bash commands - show command preview
      if (lowerName.includes('bash') && inputObj.command) {
        const cmd = String(inputObj.command).substring(0, 30);
        return `${toolName}: ${cmd}${cmd.length > 30 ? '...' : ''}`;
      }
      
      // Todo operations - show count
      if (lowerName.includes('todo') && inputObj.todos && Array.isArray(inputObj.todos)) {
        const count = inputObj.todos.length;
        return `${toolName}: ${count} task${count === 1 ? '' : 's'}`;
      }
    }
    
    // Default to tool name
    return toolName;
  }

  private getToolLocation(toolName: string, input?: unknown): { path: string; line?: number } | undefined {
    if (!input || typeof input !== 'object' || input === null) {
      return undefined;
    }
    
    const inputObj = input as Record<string, unknown>;
    
    // File operations - extract path and line info
    if (inputObj.file_path && typeof inputObj.file_path === 'string') {
      const location: { path: string; line?: number } = {
        path: inputObj.file_path
      };
      
      // Check for line numbers in various tool inputs
      if (typeof inputObj.line === 'number') {
        location.line = inputObj.line;
      } else if (typeof inputObj.offset === 'number') {
        location.line = inputObj.offset;
      }
      
      return location;
    }
    
    return undefined;
  }

  private mapToolKind(
    toolName: string,
  ):
    | "read"
    | "edit"
    | "delete"
    | "move"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "other" {
    // Exact tool name mappings for specialized tools
    switch (toolName) {
      case "Read":
      case "Glob":
      case "LS":
        return "read";
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return "edit";
      case "Grep":
      case "WebSearch":
        return "search";
      case "Bash":
      case "KillBash":
      case "BashOutput":
        return "execute";
      case "WebFetch":
        return "fetch";
      case "TodoWrite":
      case "ExitPlanMode":
        return "think";
      default:
        break;
    }
    
    // MCP tool prefixes
    if (toolName.startsWith("mcp__")) {
      const mcpToolName = toolName.split("__").pop()?.toLowerCase() || "";
      if (mcpToolName.includes("read") || mcpToolName.includes("get") || mcpToolName.includes("list")) {
        return "read";
      } else if (mcpToolName.includes("write") || mcpToolName.includes("create") || mcpToolName.includes("update") || mcpToolName.includes("add")) {
        return "edit";
      } else if (mcpToolName.includes("delete") || mcpToolName.includes("remove") || mcpToolName.includes("close")) {
        return "delete";
      } else if (mcpToolName.includes("search") || mcpToolName.includes("find")) {
        return "search";
      } else if (mcpToolName.includes("fetch") || mcpToolName.includes("navigate") || mcpToolName.includes("request")) {
        return "fetch";
      } else if (mcpToolName.includes("execute") || mcpToolName.includes("run") || mcpToolName.includes("click") || mcpToolName.includes("fill") || mcpToolName.includes("keyboard")) {
        return "execute";
      }
      return "other";
    }
    
    // Fallback to pattern matching for unknown tools
    const lowerName = toolName.toLowerCase();
    if (
      lowerName.includes("read") ||
      lowerName.includes("view") ||
      lowerName.includes("get")
    ) {
      return "read";
    } else if (
      lowerName.includes("write") ||
      lowerName.includes("create") ||
      lowerName.includes("update") ||
      lowerName.includes("edit")
    ) {
      return "edit";
    } else if (lowerName.includes("delete") || lowerName.includes("remove")) {
      return "delete";
    } else if (lowerName.includes("move") || lowerName.includes("rename")) {
      return "move";
    } else if (
      lowerName.includes("search") ||
      lowerName.includes("find") ||
      lowerName.includes("grep")
    ) {
      return "search";
    } else if (
      lowerName.includes("run") ||
      lowerName.includes("execute") ||
      lowerName.includes("bash")
    ) {
      return "execute";
    } else if (lowerName.includes("think") || lowerName.includes("plan")) {
      return "think";
    } else if (lowerName.includes("fetch") || lowerName.includes("download")) {
      return "fetch";
    } else {
      return "other";
    }
  }

  /**
   * Cleanup orphaned agent sessions that no longer have context data
   */
  private cleanupOrphanedSessions(): void {
    const activeContextSessions = new Set(this.contextMonitor.getAllStats().keys());
    let cleanedCount = 0;
    
    for (const [sessionId, session] of this.sessions.entries()) {
      // Skip active sessions that still have pending operations
      if (session.pendingPrompt || session.abortController) {
        continue;
      }
      
      // Remove sessions that have no context data and no Claude session
      if (!activeContextSessions.has(sessionId) && !session.claudeSessionId) {
        this.sessions.delete(sessionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.log(`Cleaned up ${cleanedCount} orphaned agent sessions`, 'DEBUG');
    }
  }

  /**
   * Get comprehensive session summary including context and permission info
   */
  getSessionSummary(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    const contextSummary = this.contextMonitor.getSessionSummary(sessionId);
    
    if (!session) {
      return `Session ${sessionId}: Not found`;
    }
    
    const status = session.pendingPrompt ? '🔄 Active' : '💤 Idle';
    const permission = session.permissionMode || this.defaultPermissionMode;
    const claudeSession = session.claudeSessionId ? `Claude:${session.claudeSessionId.substring(0, 8)}` : 'New';
    
    return `${status} ${claudeSession} | ${permission} | ${contextSummary}`;
  }

  /**
   * Enhanced retry logic for operations that may fail transiently
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    context: string,
    maxAttempts: number = this.MAX_RETRY_ATTEMPTS
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await operation();
        if (attempt > 1) {
          this.log(`Operation succeeded on attempt ${attempt}`, 'INFO', { context, attempt });
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        
        this.log(`Operation failed on attempt ${attempt}/${maxAttempts}`, 'WARN', {
          context,
          attempt,
          error: lastError.message
        });
        
        // Don't retry on final attempt or for certain error types
        if (attempt === maxAttempts || this.isNonRetryableError(lastError)) {
          break;
        }
        
        // Exponential backoff with jitter
        const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }

  /**
   * Determine if an error should not be retried
   */
  private isNonRetryableError(error: Error): boolean {
    const nonRetryablePatterns = [
      /authentication/i,
      /permission denied/i,
      /invalid.*request/i,
      /malformed/i,
      /syntax error/i
    ];
    
    return nonRetryablePatterns.some(pattern => pattern.test(error.message));
  }

  /**
   * Enhanced error reporting with categorization
   */
  private categorizeError(error: Error): {
    category: 'network' | 'auth' | 'validation' | 'resource' | 'unknown';
    severity: 'low' | 'medium' | 'high' | 'critical';
    recoverable: boolean;
  } {
    const message = error.message.toLowerCase();
    
    if (message.includes('network') || message.includes('timeout') || message.includes('connection')) {
      return { category: 'network', severity: 'medium', recoverable: true };
    }
    
    if (message.includes('auth') || message.includes('permission') || message.includes('unauthorized')) {
      return { category: 'auth', severity: 'high', recoverable: false };
    }
    
    if (message.includes('invalid') || message.includes('malformed') || message.includes('syntax')) {
      return { category: 'validation', severity: 'medium', recoverable: false };
    }
    
    if (message.includes('memory') || message.includes('limit') || message.includes('quota')) {
      return { category: 'resource', severity: 'high', recoverable: true };
    }
    
    return { category: 'unknown', severity: 'medium', recoverable: true };
  }

  /**
   * Process tool output content to detect and create enhanced content blocks
   */
  private async processToolOutputContent(
    outputText: string,
    toolName?: string
  ): Promise<Array<{ type: "content"; content: { type: "text"; text: string } }>> {
    // Default text content
    const defaultContent = [{
      type: "content" as const,
      content: {
        type: "text" as const,
        text: outputText,
      },
    }];

    try {
      // Enhanced content processing - for now return as text with descriptive labels
      let enhancedText = outputText;
      
      // Check if this is a file operation that should create resource content
      if (this.isFileOperation(toolName, outputText)) {
        const resourceInfo = this.createResourceContent(outputText, toolName);
        if (resourceInfo && resourceInfo.type === "resource_link") {
          enhancedText = `[+] ${resourceInfo.description || `File: ${resourceInfo.name}`}\n${outputText}`;
        }
      }
      
      // Check for diff content
      else if (this.isDiffOutput(outputText, toolName)) {
        const diffMetadata = this.parseDiffMetadata(outputText, toolName);
        const languageInfo = diffMetadata.language ? ` (${diffMetadata.language})` : '';
        const changeStats = `+${diffMetadata.linesAdded}/-${diffMetadata.linesRemoved}`;
        enhancedText = `[~] Code changes detected${languageInfo} [${changeStats}]:\n${outputText}`;
      }
      
      // Check for image/audio content
      else {
        const mediaContent = await this.detectMediaContent(outputText);
        if (mediaContent && mediaContent.type === "text") {
          enhancedText = `${mediaContent.text}\n${outputText}`;
        } else if (mediaContent && mediaContent.type === "resource_link") {
          enhancedText = `[*] Media file: ${mediaContent.description}\n${outputText}`;
        }
      }
      
      // Return enhanced text if different from original
      if (enhancedText !== outputText) {
        return [{
          type: "content" as const,
          content: {
            type: "text" as const,
            text: enhancedText,
          },
        }];
      }

    } catch (error) {
      this.log(`Error processing enhanced content: ${error}`, 'WARN');
    }

    return defaultContent;
  }

  /**
   * Check if tool output represents a file operation
   */
  private isFileOperation(toolName?: string, output?: string): boolean {
    const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob'];
    if (toolName && fileTools.includes(toolName)) {
      return true;
    }
    
    // Check output patterns that suggest file operations
    if (!output) return false;
    
    const filePatterns = [
      /^\s*\d+→/, // Line numbers (Read tool output)
      /Applied \d+ edit/, // Edit tool output
      /Created file/, // Write tool output
      /^\/.+\.(ts|js|py|java|cpp|c|h|css|html|json|md|txt)$/m, // File paths
    ];
    
    return filePatterns.some(pattern => pattern.test(output));
  }

  /**
   * Create resource content block for file operations with enhanced metadata
   */
  private createResourceContent(
    output: string,
    toolName?: string
  ): { type: string; uri?: string; name?: string; mimeType?: string; description?: string; text?: string; metadata?: ResourceMetadata } | null {
    try {
      // Extract file path from output
      let filePath: string | null = null;
      
      // Try to extract file path from various patterns
      const pathPatterns = [
        /^\s*File path: (.+)$/m,
        /^\s*Reading (.+)$/m,
        /^\s*Writing (.+)$/m,
        /^\s*Editing (.+)$/m,
        /^(\/[^\s]+\.[^\s]+)$/m, // Any file path with extension
        /^([^\s]*\/[^\s]*\.[^\s]+)$/m, // Relative file path with extension
      ];
      
      for (const pattern of pathPatterns) {
        const match = output.match(pattern);
        if (match && match[1]) {
          filePath = match[1].trim();
          break;
        }
      }
      
      if (!filePath) return null;
      
      // Detect MIME type from file extension
      const extension = filePath.substring(filePath.lastIndexOf('.'));
      const mimeType = MIME_TYPE_MAPPINGS[extension] || 'text/plain';
      
      const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
      
      // Generate enhanced metadata if supported
      const metadata = this.extendedClientCapabilities.experimental?.resourceMetadata 
        ? this.generateResourceMetadata(output, filePath, toolName) 
        : undefined;
      
      return {
        type: "resource_link",
        uri: `file://${filePath}`,
        name: fileName,
        mimeType,
        description: `${toolName || 'File'} operation: ${fileName}`,
        ...(metadata && { metadata }),
      };
    } catch (error) {
      this.log(`Error creating resource content: ${error}`, 'WARN');
      return null;
    }
  }

  /**
   * Generate enhanced resource metadata
   */
  private generateResourceMetadata(output: string, filePath: string, toolName?: string): ResourceMetadata {
    const metadata: ResourceMetadata = {};
    
    // Extract file size if available in output
    const sizeMatch = output.match(/(\d+)\s*bytes?/i);
    if (sizeMatch) {
      metadata.size = parseInt(sizeMatch[1], 10);
    }
    
    // Detect encoding
    if (output.includes('UTF-8') || output.includes('utf-8')) {
      metadata.encoding = 'utf-8';
    } else if (output.includes('ASCII') || output.includes('ascii')) {
      metadata.encoding = 'ascii';
    } else {
      metadata.encoding = 'utf-8'; // Default assumption
    }
    
    // Detect language from file path
    metadata.language = this.detectLanguageFromPath(filePath);
    
    // Extract last modified if available
    const modifiedMatch = output.match(/modified[:\s]+([^\n]+)/i);
    if (modifiedMatch) {
      try {
        const date = new Date(modifiedMatch[1].trim());
        if (!isNaN(date.getTime())) {
          metadata.lastModified = date.toISOString();
        }
      } catch {
        // Ignore date parsing errors
      }
    }
    
    // Extract permissions if available (Unix style)
    const permMatch = output.match(/permissions?[:\s]+([rwx-]{9,10})/i);
    if (permMatch) {
      metadata.permissions = permMatch[1];
    }
    
    // For Read operations, try to estimate content from line count
    if (toolName === 'Read') {
      const lineCount = output.split('\n').length;
      // Rough estimate: average 80 characters per line
      if (!metadata.size && lineCount > 1) {
        metadata.size = lineCount * 80;
      }
    }
    
    return metadata;
  }

  private shouldEnableStreaming(toolName?: string): boolean {
    if (!this.extendedClientCapabilities.experimental?.streamingContent) return false;
    
    // Enable streaming for long-running operations
    const streamingTools = ['bash', 'webfetch', 'websearch', 'multiedit'];
    const lowerToolName = toolName?.toLowerCase() || '';
    
    return streamingTools.some(tool => lowerToolName.includes(tool)) ||
           toolName?.startsWith('mcp__') === true;
  }

  private startStreaming(toolCallId: string, estimatedSize?: number): void {
    this.streamingUpdates.set(toolCallId, {
      chunks: [],
      totalSize: estimatedSize,
    });
  }

  private addStreamingChunk(toolCallId: string, chunk: string, sessionId: string): void {
    const streaming = this.streamingUpdates.get(toolCallId);
    if (!streaming) return;
    
    streaming.chunks.push(chunk);
    
    // Send streaming update
    const updatePromise = this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        content: [{
          type: "content" as const,
          content: {
            type: "text" as const,
            text: chunk,
          },
        }],
      },
    });
    
    // Handle promise if it exists (for real client calls)
    if (updatePromise?.catch) {
      updatePromise.catch(error => {
        this.log(`Error sending streaming update: ${error}`, 'WARN');
      });
    }
  }

  private completeStreaming(toolCallId: string, _sessionId: string): string {
    const streaming = this.streamingUpdates.get(toolCallId);
    if (!streaming) return '';
    
    const fullContent = streaming.chunks.join('');
    this.streamingUpdates.delete(toolCallId);
    return fullContent;
  }

  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private shouldBatchToolCalls(toolNames: string[]): boolean {
    if (!this.extendedClientCapabilities.experimental?.toolCallBatching) return false;
    if (toolNames.length < 2) return false;
    
    // Batch file operations that are related
    const fileOperations = ['read', 'write', 'edit', 'multiedit', 'glob', 'ls'];
    const batchableOperations = toolNames.filter(name => 
      fileOperations.some(op => name.toLowerCase().includes(op))
    );
    
    // If most operations are file-related, batch them
    return batchableOperations.length >= Math.ceil(toolNames.length * 0.7);
  }

  private createToolCallBatch(
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    batchType: 'parallel' | 'sequential' = 'sequential'
  ): ToolCallBatch {
    const batchId = this.generateBatchId();
    
    const batch: ToolCallBatch = {
      batchId,
      batchType,
      toolCalls: toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        status: 'pending' as const,
      })),
      metadata: {
        totalOperations: toolCalls.length,
        completedOperations: 0,
        failedOperations: 0,
      },
    };
    
    this.activeBatches.set(batchId, batch);
    return batch;
  }

  private updateBatchedToolCall(
    batchId: string,
    toolCallId: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    output?: string,
    error?: string
  ): void {
    const batch = this.activeBatches.get(batchId);
    if (!batch) return;
    
    const toolCall = batch.toolCalls.find(tc => tc.id === toolCallId);
    if (!toolCall) return;
    
    const previousStatus = toolCall.status;
    toolCall.status = status;
    toolCall.output = output;
    toolCall.error = error;
    
    // Update batch metadata
    if (previousStatus !== 'completed' && status === 'completed') {
      batch.metadata!.completedOperations++;
    }
    if (previousStatus !== 'failed' && status === 'failed') {
      batch.metadata!.failedOperations++;
    }
    
    this.log(`Batch ${batchId} tool ${toolCallId}: ${previousStatus} -> ${status}`, 'DEBUG');
  }

  private sendBatchUpdate(sessionId: string, batchId: string): void {
    const batch = this.activeBatches.get(batchId);
    if (!batch) return;
    
    const completedCount = batch.metadata!.completedOperations;
    const totalCount = batch.metadata!.totalOperations;
    const progress = Math.round((completedCount / totalCount) * 100);
    
    const updatePromise = this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: batchId,
        status: completedCount === totalCount ? "completed" : "in_progress",
        content: [{
          type: "content" as const,
          content: {
            type: "text" as const,
            text: `Batch operation: ${completedCount}/${totalCount} completed (${progress}%)`,
          },
        }],
      },
    });
    
    // Handle promise if it exists (for real client calls)
    if (updatePromise?.catch) {
      updatePromise.catch(error => {
        this.log(`Error sending batch update: ${error}`, 'WARN');
      });
    }
    
    // Clean up completed batches
    if (completedCount === totalCount) {
      this.activeBatches.delete(batchId);
    }
  }

  private isBatchComplete(batchId: string): boolean {
    const batch = this.activeBatches.get(batchId);
    if (!batch) return true;
    
    return batch.metadata!.completedOperations + batch.metadata!.failedOperations === batch.metadata!.totalOperations;
  }

  /**
   * Detect the type of file operation
   */
  private detectFileOperation(toolName?: string, output?: string): string {
    if (toolName) {
      const operations: Record<string, string> = {
        'Read': 'read',
        'Write': 'write',
        'Edit': 'edit',
        'MultiEdit': 'edit',
        'Glob': 'search',
      };
      return operations[toolName] || 'unknown';
    }
    
    if (output) {
      if (output.includes('Applied') && output.includes('edit')) return 'edit';
      if (output.includes('Created file')) return 'write';
      if (output.includes('→')) return 'read'; // Line number format
    }
    
    return 'unknown';
  }

  /**
   * Check if output represents diff content
   */
  private isDiffOutput(output: string, toolName?: string): boolean {
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      return output.includes('Applied') && output.includes('edit');
    }
    
    // Check for diff-like patterns
    const diffPatterns = [
      /^[-+]\s/m, // Git diff style
      /^@@\s/m,   // Hunk headers
      /^diff --git/m, // Git diff headers
    ];
    
    return diffPatterns.some(pattern => pattern.test(output));
  }

  /**
   * Create diff content block with enhanced metadata
   */
  private createDiffContent(output: string, toolName?: string): { type: string; text?: string; metadata?: DiffMetadata } | null {
    try {
      const metadata = this.parseDiffMetadata(output, toolName);
      
      return {
        type: "text",
        text: output,
        ...(this.extendedClientCapabilities.experimental?.richDiffs && { metadata }),
      };
    } catch (error) {
      this.log(`Error creating diff content: ${error}`, 'WARN');
      return null;
    }
  }

  /**
   * Parse diff metadata from output with granular hunk support
   */
  private parseDiffMetadata(output: string, toolName?: string): DiffMetadata {
    let linesAdded = 0;
    let linesRemoved = 0;
    let language: string | undefined = undefined;
    let hunks: DiffHunk[] | undefined = undefined;
    
    // For Edit/MultiEdit tools, try to extract from success message
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      // Extract file path for language detection
      const filePathMatch = output.match(/to\s+([^\s]+\.[a-zA-Z0-9]+)/);
      if (filePathMatch) {
        const filePath = filePathMatch[1];
        language = this.detectLanguageFromPath(filePath);
      }
      
      // Simple heuristic: assume 1 change for basic edits
      linesAdded = 1;
      linesRemoved = 0;
    } else {
      // Parse unified diff format with granular hunks
      const parsedHunks = this.parseUnifiedDiffHunks(output);
      if (parsedHunks.length > 0) {
        hunks = parsedHunks;
        
        // Calculate totals from hunks
        for (const hunk of hunks) {
          linesAdded += hunk.metadata?.linesAdded || 0;
          linesRemoved += hunk.metadata?.linesRemoved || 0;
        }
      } else {
        // Fallback to simple line counting
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            linesAdded++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            linesRemoved++;
          }
        }
      }
      
      // Try to detect language from file headers
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.startsWith('---') || line.startsWith('+++')) {
          const fileMatch = line.match(/[ab]\/([^\s]+)/);
          if (fileMatch) {
            const filePath = fileMatch[1];
            language = this.detectLanguageFromPath(filePath);
            break;
          }
        }
      }
    }
    
    return {
      linesAdded,
      linesRemoved,
      language,
      encoding: 'utf-8', // Default assumption
      ...(this.extendedClientCapabilities.experimental?.richDiffs && hunks && { hunks }),
    };
  }

  /**
   * Parse unified diff format into granular hunks
   */
  private parseUnifiedDiffHunks(diffOutput: string): DiffHunk[] {
    const lines = diffOutput.split('\n');
    const hunks: DiffHunk[] = [];
    let currentHunk: Partial<DiffHunk> | null = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for hunk header (@@)
      const hunkHeaderMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@(.*)$/);
      if (hunkHeaderMatch) {
        // Finish previous hunk
        if (currentHunk && currentHunk.changes) {
          hunks.push(currentHunk as DiffHunk);
        }
        
        // Start new hunk
        const oldStart = parseInt(hunkHeaderMatch[1], 10);
        const oldLength = hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1;
        const newStart = parseInt(hunkHeaderMatch[3], 10);
        const newLength = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1;
        const header = line;
        
        currentHunk = {
          oldStart,
          oldLength,
          newStart,
          newLength,
          header,
          changes: [],
          metadata: {
            linesAdded: 0,
            linesRemoved: 0,
            linesContext: 0,
          },
        };
        continue;
      }
      
      // Process change lines within a hunk
      if (currentHunk && currentHunk.changes) {
        let changeType: DiffChange['type'] | null = null;
        let content = line;
        
        if (line.startsWith('+')) {
          changeType = 'add';
          content = line.substring(1);
          currentHunk.metadata!.linesAdded++;
        } else if (line.startsWith('-')) {
          changeType = 'remove';
          content = line.substring(1);
          currentHunk.metadata!.linesRemoved++;
        } else if (line.startsWith(' ') || line === '') {
          changeType = 'context';
          content = line.substring(1);
          currentHunk.metadata!.linesContext++;
        }
        
        if (changeType) {
          const change: DiffChange = {
            type: changeType,
            line,
            content,
          };
          
          // Calculate line numbers
          if ((changeType === 'add' || changeType === 'context') && currentHunk.newStart !== undefined) {
            const previousNewLines = currentHunk.changes
              .filter(c => c.type === 'add' || c.type === 'context').length;
            change.newLineNumber = currentHunk.newStart + previousNewLines;
          }
          
          if ((changeType === 'remove' || changeType === 'context') && currentHunk.oldStart !== undefined) {
            const previousOldLines = currentHunk.changes
              .filter(c => c.type === 'remove' || c.type === 'context').length;
            change.oldLineNumber = currentHunk.oldStart + previousOldLines;
          }
          
          currentHunk.changes.push(change);
        }
      }
    }
    
    // Finish final hunk
    if (currentHunk && currentHunk.changes) {
      hunks.push(currentHunk as DiffHunk);
    }
    
    return hunks;
  }

  /**
   * Detect programming language from file path
   */
  private detectLanguageFromPath(filePath: string): string | undefined {
    const extension = filePath.toLowerCase().split('.').pop();
    
    const languageMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'h': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'css': 'css',
      'scss': 'scss',
      'html': 'html',
      'xml': 'xml',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sql': 'sql',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'fish': 'bash',
    };
    
    return extension ? languageMap[extension] : undefined;
  }

  /**
   * Detect media content (images, audio) in output
   */
  private async detectMediaContent(
    output: string
  ): Promise<{ type: string; text?: string; uri?: string; name?: string; mimeType?: string; description?: string } | null> {
    try {
      // Check for base64 image data
      const base64ImagePattern = /data:image\/([^;]+);base64,([A-Za-z0-9+/=]+)/;
      const imageMatch = output.match(base64ImagePattern);
      
      if (imageMatch) {
        return {
          type: "text",
          text: `[Image detected: ${imageMatch[1]} format]`,
        };
      }
      
      // Check for audio data
      const base64AudioPattern = /data:audio\/([^;]+);base64,([A-Za-z0-9+/=]+)/;
      const audioMatch = output.match(base64AudioPattern);
      
      if (audioMatch) {
        return {
          type: "text",
          text: `[Audio detected: ${audioMatch[1]} format]`,
        };
      }
      
      // Check for image/audio file paths
      const mediaFilePattern = /\b([^\s]+\.(png|jpg|jpeg|gif|svg|webp|mp3|wav|ogg|m4a))\b/i;
      const mediaFileMatch = output.match(mediaFilePattern);
      
      if (mediaFileMatch) {
        const filePath = mediaFileMatch[1];
        const extension = mediaFileMatch[2].toLowerCase();
        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(extension);
        const isAudio = ['mp3', 'wav', 'ogg', 'm4a'].includes(extension);
        
        if (isImage) {
          return {
            type: "resource_link",
            uri: `file://${filePath}`,
            name: filePath.substring(filePath.lastIndexOf('/') + 1),
            mimeType: MIME_TYPE_MAPPINGS[`.${extension}`] || 'image/jpeg',
            description: `Image file: ${filePath}`,
          };
        } else if (isAudio) {
          return {
            type: "resource_link",
            uri: `file://${filePath}`,
            name: filePath.substring(filePath.lastIndexOf('/') + 1),
            mimeType: MIME_TYPE_MAPPINGS[`.${extension}`] || 'audio/mpeg',
            description: `Audio file: ${filePath}`,
          };
        }
      }
      
      return null;
    } catch (error) {
      this.log(`Error detecting media content: ${error}`, 'WARN');
      return null;
    }
  }

  /**
   * Check if a tool is allowed to execute based on permissions
   */
  private isToolAllowed(toolName: string): boolean {
    const config = this.toolPermissions;
    
    // Check explicit deny list
    if (config.disallowedTools?.includes(toolName)) {
      return false;
    }
    
    // Check explicit allow list (if present, only these tools are allowed)
    if (config.allowedTools && config.allowedTools.length > 0) {
      return config.allowedTools.includes(toolName);
    }
    
    // Check per-tool permissions
    if (config.toolPermissions && toolName in config.toolPermissions) {
      const permission = config.toolPermissions[toolName];
      return permission !== "deny"; // allow both "allow" and "ask" permissions
    }
    
    // Use default permission
    return config.defaultPermission !== "deny";
  }

  /**
   * Update tool permissions configuration
   */
  public updateToolPermissions(config: Partial<ToolPermissionConfig>): void {
    this.toolPermissions = {
      ...this.toolPermissions,
      ...config,
    };
    
    this.log(`Updated tool permissions`, 'INFO', { config });
  }

  /**
   * Get current tool permissions configuration
   */
  public getToolPermissions(): ToolPermissionConfig {
    return { ...this.toolPermissions };
  }
}
