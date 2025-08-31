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
import { createLogger, type Logger } from "./logger.js";

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
  private readonly logger: Logger;
  private maxTurns: number;
  private defaultPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  private pathToClaudeCodeExecutable: string | undefined;
  private clientCapabilities: ClientCapabilities = {};
  private extendedClientCapabilities: ExtendedClientCapabilities = {};
  private toolExecutionTiming: Map<string, ToolExecutionTiming> = new Map();
  private streamingUpdates: Map<string, { chunks: string[]; totalSize?: number }> = new Map();
  private activeBatches: Map<string, ToolCallBatch> = new Map();
  private streamingCleanupTimer?: NodeJS.Timeout;
  private batchCleanupTimer?: NodeJS.Timeout;
  private queryQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
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
    
    this.logger = createLogger('ClaudeACPAgent');
    
    this.validateConfiguration();
    this.contextMonitor = new ContextMonitor(process.env.ACP_DEBUG === "true");
    this.sessionPersistence = getDefaultPersistenceManager();
    
    this.logger.info(`Initialized ACP Agent - Max turns: ${this.maxTurns === 0 ? 'unlimited' : this.maxTurns}, Permission: ${this.defaultPermissionMode}`, {
      maxTurns: this.maxTurns,
      permissionMode: this.defaultPermissionMode
    });
    
    // Session cleanup and monitoring
    setInterval(() => {
      const cleanedCount = this.contextMonitor.cleanupOldSessions();
      if (cleanedCount > 0) {
        this.logger.debug(`Cleaned up ${cleanedCount} old context sessions`);
      }
      
      // Memory monitoring
      this.monitorMemoryUsage();
      
      // Also cleanup orphaned agent sessions
      this.cleanupOrphanedSessions();
      
      // Cleanup old persisted sessions
      this.sessionPersistence.cleanup().catch(error => {
        this.logger.warn(`Session persistence cleanup failed: ${error}`);
      });
    }, 60 * 60 * 1000);

    // Streaming and batch cleanup (more frequent)
    this.streamingCleanupTimer = setInterval(() => {
      this.cleanupStaleStreamingUpdates();
    }, 5 * 60 * 1000); // Every 5 minutes

    this.batchCleanupTimer = setInterval(() => {
      this.cleanupStaleBatches();
    }, 10 * 60 * 1000); // Every 10 minutes
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

  private validateConfiguration(): void {
    // Validate max turns
    if (this.maxTurns < 0) {
      throw new Error(`Invalid maxTurns: ${this.maxTurns} must be >= 0`);
    }
    
    // Validate permission mode
    const validModes = ["default", "acceptEdits", "bypassPermissions", "plan"];
    if (!validModes.includes(this.defaultPermissionMode)) {
      throw new Error(`Invalid permission mode: ${this.defaultPermissionMode}`);
    }
    
    // Memory check
    const usage = process.memoryUsage();
    if (usage.heapUsed > 200 * 1024 * 1024) { // 200MB
      this.logger.warn(`High initial memory usage: ${Math.round(usage.heapUsed / 1024 / 1024)}MB`);
    }
    
    this.logger.info('Configuration validated successfully');
  }

  private monitorMemoryUsage(): void {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rss = Math.round(usage.rss / 1024 / 1024);
    
    // Log memory stats every hour
    this.logger.debug(`Memory usage: ${heapMB}MB heap, ${rss}MB RSS`);
    
    // Warn on high usage
    if (usage.heapUsed > 500 * 1024 * 1024) { // 500MB
      this.logger.warn(`High memory usage detected: ${heapMB}MB heap`);
    }
    
    // Critical memory warning
    if (usage.heapUsed > 1024 * 1024 * 1024) { // 1GB
      this.logger.error(`Critical memory usage: ${heapMB}MB heap - consider restart`);
    }
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



  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.logger.debug(`Initialize with protocol version: ${params.protocolVersion}`);
    this.logger.debug(`Client capabilities: ${JSON.stringify(params.clientCapabilities || {})}`);

    // Store client capabilities for direct operations
    this.clientCapabilities = params.clientCapabilities || {};
    
    // Detect extended experimental capabilities
    this.extendedClientCapabilities = this.detectExtendedCapabilities(params);
    this.logger.debug(`Extended capabilities: ${JSON.stringify(this.extendedClientCapabilities)}`);
    
    this.logger.debug(`File system capabilities: readTextFile=${this.clientCapabilities.fs?.readTextFile}, writeTextFile=${this.clientCapabilities.fs?.writeTextFile}`);
    this.logger.debug(`Permission system: ACP supports native permission dialogs=${!!this.client.requestPermission}`);

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true, // Enable session loading
        promptCapabilities: {
          // Claude supports image inputs (screenshots, diagrams, etc.)
          image: true,
          // Claude does not support audio inputs
          audio: false,
          // Enable embedded context for rich content processing
          embeddedContext: true
        }
      },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.logger.info("Creating new session");

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
          version: '0.9.0'
        }
      });
    } catch (error) {
      // Auto-retry session save on connection errors
      if (String(error).includes('connection') || String(error).includes('timeout')) {
        this.logger.warn(`Session save error, retrying: ${error}`, { sessionId });
        setTimeout(async () => {
          try {
            await this.sessionPersistence.saveSession({
              sessionId,
              permissionMode: this.defaultPermissionMode,
              createdAt: new Date().toISOString(),
              metadata: { userAgent: 'ACP-Claude-Code-Bridge', version: '0.9.0' }
            });
          } catch (retryError) {
            this.logger.warn(`Session save retry failed: ${retryError}`, { sessionId });
          }
        }, 1000);
      } else {
        this.logger.warn(`Failed to persist session metadata: ${error}`, { sessionId });
      }
    }

    this.logger.info(`Created session: ${sessionId}`, { sessionId, permissionMode: this.defaultPermissionMode });

    return {
      sessionId,
    };
  }

  async loadSession?(params: LoadSessionRequest): Promise<void> {
    this.logger.info(`Loading session: ${params.sessionId}`, { sessionId: params.sessionId });

    // Check if we already have this session in memory
    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      this.logger.debug(
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
        this.logger.info(`Loaded session from persistence: ${params.sessionId}`, {
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
          this.logger.debug(`Context stats available for restoration`, {
            sessionId: params.sessionId,
            tokens: persistedSession.contextStats.estimatedTokens,
            messages: persistedSession.contextStats.messages
          });
        }
        
        return;
      }
    } catch (error) {
      this.logger.warn(`Failed to load session from persistence: ${error}`, {
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

    this.logger.debug(
      `Created new session entry for loaded session: ${params.sessionId}`,
      'INFO',
      { sessionId: params.sessionId, permissionMode: this.defaultPermissionMode }
    );
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    this.logger.debug("Authenticate called");
    // Claude Code SDK handles authentication internally through ~/.claude/config.json
    // Users should run `claude setup-token` or login through the CLI
    this.logger.debug("Using Claude Code authentication from ~/.claude/config.json");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const currentSessionId = params.sessionId;
    const session = this.sessions.get(currentSessionId);

    if (!session) {
      this.logger.debug(
        `Session ${currentSessionId} not found in map. Available sessions: ${Array.from(this.sessions.keys()).join(", ")}`,
      );
      this.logger.debug(`Available context sessions: ${Array.from(this.contextMonitor.getAllStats().keys()).join(", ")}`);
      throw new Error(`Session ${currentSessionId} not found`);
    }

    this.logger.debug(`Processing prompt for session: ${currentSessionId}`);
    this.logger.debug(
      `Session state: claudeSessionId=${session.claudeSessionId}, pendingPrompt=${!!session.pendingPrompt}, abortController=${!!session.abortController}`,
    );
    this.logger.debug(
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

      this.logger.debug(
        `Prompt received (${promptText.length} chars): ${promptText}`,
      );
      
      // Track context usage for user message
      const contextWarning = this.contextMonitor.addMessage(currentSessionId, promptText);
      if (contextWarning) {
        this.logger.debug(`Context warning: ${contextWarning.message}`);
        
        // Persist updated context stats
        this.persistContextStats(currentSessionId).catch(error => {
          this.logger.warn(`Failed to persist context stats: ${error}`, { sessionId: currentSessionId });
        });
        
        // Send concise context status
        if (contextWarning.level === 'critical') {
          await this.client.sessionUpdate({
            sessionId: currentSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Context near limit (${Math.round(contextWarning.usage * 100)}%) - consider new session`,
              },
            },
          });
        } else if (contextWarning.level === 'warning') {
          await this.client.sessionUpdate({
            sessionId: currentSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Context usage: ${Math.round(contextWarning.usage * 100)}%`,
              },
            },
          });
        }
      }

      // Use simple string prompt - Claude SDK will handle history with resume
      const queryInput = promptText;

      if (!session.claudeSessionId) {
        this.logger.debug("First message for this session, no resume");
      } else {
        this.logger.debug(`Resuming Claude session: ${session.claudeSessionId}`);
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

      this.logger.debug(`Using permission mode: ${permissionMode}`);

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
      
      this.logger.debug(`Starting query with${this.maxTurns === 0 ? ' unlimited' : ` ${this.maxTurns}`} turns`);
      
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
              this.logger.debug(`Turn warning: ${turnCount}/${this.maxTurns} turns used`);
              
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
            this.logger.debug(`Unlimited session progress: ${turnCount} turns completed`);
          }
        }
        
        this.logger.debug(
          `Processing message #${messageCount} (turn ${turnCount}) of type: ${sdkMessage.type}`,
        );

        // Extract and store Claude's session_id from any message that has it
        if (
          "session_id" in sdkMessage &&
          typeof sdkMessage.session_id === "string" &&
          sdkMessage.session_id
        ) {
          if (session.claudeSessionId !== sdkMessage.session_id) {
            this.logger.debug(
              `Updating Claude session_id from ${session.claudeSessionId} to ${sdkMessage.session_id}`,
            );
            session.claudeSessionId = sdkMessage.session_id;
            // Update the session in the map to ensure persistence
            this.sessions.set(currentSessionId, session);
          }
        }

        // Log message type and content for debugging
        if (sdkMessage.type === "user") {
          this.logger.debug(`Processing user message`);
        } else if (sdkMessage.type === "assistant") {
          this.logger.debug(`Processing assistant message`);
          // Log assistant message content for debugging
          if ("message" in sdkMessage && sdkMessage.message) {
            const assistantMsg = sdkMessage.message as {
              content?: Array<{ type: string; text?: string }>;
            };
            if (assistantMsg.content) {
              this.logger.debug(
                `Assistant content: ${JSON.stringify(assistantMsg.content)}`,
              );
            }
          }
        }

        await this.handleClaudeMessage(
          currentSessionId,
          message as ClaudeMessage,
        );
      }

      this.logger.debug(`Processed ${messageCount} messages total`);
      this.logger.debug(`Final Claude session_id: ${session.claudeSessionId}`);
      session.pendingPrompt = null;

      // Ensure the session is properly saved with the Claude session_id
      this.sessions.set(currentSessionId, session);

      return {
        stopReason: "end_turn",
      };
    } catch (error) {
      this.logger.debug("Error during prompt processing:");
      
      const contextStats = this.contextMonitor.getStats(currentSessionId);
      if (contextStats) {
        this.logger.debug(`Error occurred at context usage: ${(contextStats.usage * 100).toFixed(1)}%`);
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
    this.logger.debug(`Cancel requested for session: ${params.sessionId}`);

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
    this.logger.debug(
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
              this.logger.debug(`Tool result received for: ${content.tool_use_id}`);
              
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
              const assistantContextWarning = this.contextMonitor.addMessage(sessionId, text);
              if (assistantContextWarning && assistantContextWarning.level === 'critical') {
                this.logger.debug(`Critical context usage detected: ${assistantContextWarning.message}`);
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
              this.logger.debug(
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
                  id: string;
                }>;
                const completedCount = todos.filter(t => t.status === 'completed').length;
                const totalCount = todos.length;
                
                const todoText = this.generateTaskProgressDisplay(todos, completedCount, totalCount);

                // Use proper content format with promise handling
                const updatePromise = this.client.sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text" as const,
                      text: todoText,
                    },
                  },
                });

                // Handle promise properly
                if (updatePromise?.catch) {
                  updatePromise.catch(error => {
                    this.logger.warn(`Error sending todo update: ${error}`);
                  });
                }
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
        this.logger.debug("Query completed with result:");
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
        this.logger.debug(`Tool call started: ${msg.tool_name}`, `ID: ${msg.id}`);

        // Handle tool input - ensure it's a proper object
        const input = msg.input || {};

        // Log the input for debugging
        if (process.env.ACP_DEBUG === "true") {
          try {
            this.logger.debug(`Tool input:`);

            // Special logging for content field
            if (input && typeof input === "object" && "content" in input) {
              const content = (input as Record<string, unknown>).content;
              if (typeof content === "string") {
                const preview = content.substring(0, 100);
                this.logger.debug(
                  `Content preview: ${preview}${content.length > 100 ? "..." : ""}`,
                );
              }
            }
          } catch {
            this.logger.debug("Error logging input:");
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
                  text: this.getEnhancedPermissionDescription(`execute ${msg.tool_name}`, msg.tool_name, input),
                },
              },
            ],
          };

          const permission = await this.requestUserPermission(
            sessionId,
            `execute ${msg.tool_name}`,
            toolCall,
            msg.tool_name,
            input
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
          this.logger.debug(`Tool location: ${toolLocation.path}${toolLocation.line ? `:${toolLocation.line}` : ''}`);
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
                id: string;
              }>;
            }
          ).todos;
          if (todos && Array.isArray(todos)) {
            // Convert todo objects to clean strings to prevent [object Object] display
            const completedCount = todos.filter(t => t.status === 'completed').length;
            const totalCount = todos.length;
            
            const todoText = this.generateTaskProgressDisplay(todos, completedCount, totalCount);

            // Use proper content format and add delay to prevent message flooding
            const updatePromise = this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text" as const,
                  text: todoText,
                },
              },
            });

            // Handle promise properly to avoid unhandled rejections
            updatePromise?.catch(error => {
              this.logger.warn(`Todo update error: ${error}`);
            });
          }
        }
        break;
      }

      case "tool_use_output": {
        const outputText = msg.output || "";

        // Log the tool output for debugging
        this.logger.debug(`Tool call completed: ${msg.id}`);
        this.logger.debug(`Tool output length: ${outputText.length} characters`);

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
          this.logger.debug("Content block stopped");
        }
        break;
      }

      default:
        this.logger.debug(
          `Unhandled message type: ${messageType}`,
          JSON.stringify(message).substring(0, 500),
        );
    }
  }

  /**
   * Unified permission system that handles both ACP and fallback permissions.
   * Provides consistent permission checking for all tool operations.
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
    toolName?: string,
    input?: unknown
  ): Promise<'allowed' | 'denied' | 'cancelled'> {
    const session = this.sessions.get(sessionId);
    const permissionMode = session?.permissionMode || this.defaultPermissionMode;
    const contextStats = this.contextMonitor.getStats(sessionId);
    
    this.logger.debug(`Permission check for '${operation}' - Mode: ${permissionMode}, Tool: ${toolName || 'unknown'}, Context: ${contextStats ? (contextStats.usage * 100).toFixed(1) + '%' : 'N/A'}`);

    // First check tool-specific permissions if tool name provided
    if (toolName) {
      const toolPermission = this.getToolPermissionLevel(toolName);
      
      if (toolPermission === 'deny' || !this.isToolAllowed(toolName)) {
        this.logger.debug(`\u274c Tool '${toolName}' explicitly denied by configuration`);
        return 'denied';
      }
      
      if (toolPermission === 'allow' && permissionMode !== 'plan') {
        this.logger.debug(`\u2705 Tool '${toolName}' explicitly allowed by configuration`);
        return 'allowed';
      }
    }

    // Check permission mode for bypass/auto-accept
    if (permissionMode === 'bypassPermissions') {
      this.logger.debug(`\u2705 Bypassing permission request for ${operation} (mode: ${permissionMode})`);
      return 'allowed';
    }

    if (permissionMode === 'acceptEdits') {
      // Simplified acceptEdits logic: auto-accept non-execute operations
      if (toolCall.kind !== 'execute' && !this.isExecuteOperation(operation)) {
        this.logger.debug(`\u2705 Auto-accepting ${toolCall.kind} operation: ${operation} (mode: ${permissionMode})`);
        return 'allowed';
      }
      this.logger.debug(`\u26a0\ufe0f Execute operation requires explicit permission even in acceptEdits mode`);
    }

    // Always request permission in plan mode
    if (permissionMode === 'plan') {
      this.logger.debug(`\ud83d\udccb Plan mode - requesting permission for review: ${operation}`);
      // Continue to permission dialog
    }

    // Use ACP native permission dialog if available
    if (this.client && typeof this.client.requestPermission === 'function') {
      return await this.requestACPPermission(sessionId, operation, toolCall, toolName, input);
    }

    // Fallback to default behavior
    this.logger.debug(`Default permission granted for: ${operation}`);
    return 'allowed';
  }

  /**
   * Request permission using ACP protocol with standardized options.
   */
  private async requestACPPermission(
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
    toolName?: string,
    input?: unknown
  ): Promise<'allowed' | 'denied' | 'cancelled'> {
    this.logger.debug(`Requesting ACP permission for: ${operation}`);
      
    try {
      // Standard ACP permission options
      const options: PermissionOption[] = [
        {
          optionId: 'allow',
          name: 'Allow',
          kind: 'allow_once' as const,
        },
        {
          optionId: 'deny',
          name: 'Deny',
          kind: 'reject_once' as const,
        }
      ];
      
      // Add "Always Allow" for non-execute operations only
      if (!this.isExecuteOperation(operation) && toolCall.kind !== 'execute') {
        options.push({
          optionId: 'always',
          name: 'Always Allow',
          kind: 'allow_always' as const,
        });
      }

      // Enhance tool call with better context
      const enhancedToolCall = {
        ...toolCall,
        title: this.getEnhancedPermissionTitle(operation, toolName, input),
        content: [
          {
            type: 'content' as const,
            content: {
              type: 'text' as const,
              text: this.getEnhancedPermissionDescription(operation, toolName, input),
            },
          },
        ],
      };

      const permissionRequest: RequestPermissionRequest = {
        sessionId,
        toolCall: enhancedToolCall,
        options,
      };

      const response = await this.client.requestPermission!(permissionRequest);
      
      if (response.outcome.outcome === 'cancelled') {
        this.logger.debug(`Permission request cancelled for: ${operation}`);
        return 'cancelled';
      } else if (response.outcome.outcome === 'selected') {
        const selectedOption = response.outcome.optionId;
        this.logger.debug(`Permission ${selectedOption} selected for: ${operation}`);
        
        // Handle "always allow" by switching to acceptEdits mode
        const session = this.sessions.get(sessionId);
        if (selectedOption === 'always' && session) {
          session.permissionMode = 'acceptEdits';
          this.logger.debug(`⚙️ Switched to acceptEdits mode for future similar operations`);
        }
        
        return selectedOption === 'allow' || selectedOption === 'always' ? 'allowed' : 'denied';
      }
    } catch (error) {
      this.logger.error(`ACP permission request failed: ${error instanceof Error ? error.message : String(error)}`);
      
      // Return denied on error to be safe
      this.logger.debug(`Denying operation due to permission system error: ${operation}`);
      return 'denied';
    }

    // Should not reach here, but return denied as safe default
    return 'denied';
  }

  /**
   * Check if an operation is an execute/command operation.
   */
  private isExecuteOperation(operation: string): boolean {
    const executeKeywords = ['bash', 'execute', 'command', 'run', 'script', 'shell'];
    const operationLower = operation.toLowerCase();
    return executeKeywords.some(keyword => operationLower.includes(keyword));
  }

  /**
   * Generate enhanced permission title with context.
   */
  private getEnhancedPermissionTitle(operation: string, toolName?: string, input?: unknown): string {
    if (toolName && input && typeof input === 'object' && input !== null) {
      const inputObj = input as Record<string, unknown>;
      
      // File operations
      if (inputObj.file_path || inputObj.path) {
        const filePath = String(inputObj.file_path || inputObj.path);
        const fileName = filePath.split('/').pop() || filePath;
        return `${toolName}: ${fileName}`;
      }
      
      // Command operations
      if (inputObj.command) {
        const command = String(inputObj.command);
        return `Execute: ${command}`;
      }
    }
    
    return operation;
  }

  /**
   * Generate enhanced permission description with context and risk information.
   */
  private getEnhancedPermissionDescription(operation: string, toolName?: string, input?: unknown): string {
    let description = operation;
    let riskLevel = '';
    
    if (toolName && input && typeof input === 'object' && input !== null) {
      const inputObj = input as Record<string, unknown>;
      
      // File operations with paths
      if (inputObj.file_path || inputObj.path) {
        const filePath = String(inputObj.file_path || inputObj.path);
        description = `${toolName} operation on: ${filePath}`;
        
        if (toolName.toLowerCase().includes('write') || toolName.toLowerCase().includes('edit')) {
          riskLevel = '⚠️ Modifies files';
        } else if (toolName.toLowerCase().includes('delete')) {
          riskLevel = '🚨 Deletes files';
        }
      }
      
      // Command operations
      else if (inputObj.command) {
        const command = String(inputObj.command);
        description = `Execute command: ${command}`;
        riskLevel = '🚨 Executes system commands';
      }
      
      // Content operations
      else if (inputObj.content) {
        const contentLength = String(inputObj.content).length;
        description = `${operation} (${contentLength} characters)`;
      }
    }
    
    return riskLevel ? `${description}\n\n${riskLevel}` : description;
  }

  /**
   * Generate enhanced task progress display with better formatting and progress bar.
   */
  private generateTaskProgressDisplay(
    todos: Array<{
      content: string | unknown;
      status: string;
      id: string;
    }>,
    completedCount: number,
    totalCount: number
  ): string {
    const progressPercent = Math.round((completedCount / totalCount) * 100);
    
    // Find current task for concise display
    const currentTask = todos.find(t => t.status === 'in_progress');
    if (!currentTask) {
      return `✓ All ${totalCount} tasks completed`;
    }
    
    const currentTaskContent = typeof currentTask.content === 'string' ? 
      currentTask.content : JSON.stringify(currentTask.content);
    
    // Elegant single-line progress with current task
    return `Task ${completedCount + 1}/${totalCount}: ${currentTaskContent}`;
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
          this.logger.debug(`Invalid file path for ACP readTextFile: "${filePath}"`);
          return false;
        }

        this.logger.debug(`Using ACP direct readTextFile for: ${filePath}`);

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
          'Read',
          inputObj
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

        this.logger.debug(`ACP readTextFile completed: ${response.content.length} characters from ${filePath}`);
        return true;
      }

      // Handle Write operations with ACP writeTextFile  
      if (lowerToolName === 'write' && this.clientCapabilities.fs?.writeTextFile && inputObj.file_path && inputObj.content) {
        // Validate file path and content
        const filePath = String(inputObj.file_path).trim();
        const content = String(inputObj.content);
        
        if (!filePath || filePath.length === 0) {
          this.logger.debug(`Invalid file path for ACP writeTextFile: "${filePath}"`);
          return false;
        }

        this.logger.debug(`Using ACP direct writeTextFile for: ${filePath} (${content.length} chars)`);

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
          'Write',
          inputObj
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

        this.logger.debug(`ACP writeTextFile completed: ${content.length} characters to ${filePath}`);
        return true;
      }

    } catch (error) {
      this.logger.error(`ACP direct file operation failed for ${toolName}: ${error}`);
      
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
        this.logger.error(`Failed to send error update: ${updateError}`);
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
        const cmd = String(inputObj.command);
        return `${toolName}: ${cmd}`;
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
      this.logger.debug(`Cleaned up ${cleanedCount} orphaned agent sessions`);
    }
  }

  /**
   * Get comprehensive session summary including context and permission info
   */
  getSessionSummary(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    const contextStats = this.contextMonitor.getStats(sessionId);
    
    if (!session) {
      return `Session ${sessionId}: Not found`;
    }
    
    const status = session.pendingPrompt ? '🔄 Active' : '💤 Idle';
    const permission = session.permissionMode || this.defaultPermissionMode;
    const claudeSession = session.claudeSessionId ? `Claude:${session.claudeSessionId.substring(0, 8)}` : 'New';
    
    const contextInfo = contextStats 
      ? `${Math.round(contextStats.usage * 100)}%`
      : '0%';

    return `${status} ${claudeSession} | ${permission} | ${contextInfo}`;
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
          this.logger.info(`Operation succeeded on attempt ${attempt}`, { context, attempt });
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        
        this.logger.warn(`Operation failed on attempt ${attempt}/${maxAttempts}`, {
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
      this.logger.warn(`Error processing enhanced content: ${error}`);
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
      this.logger.warn(`Error creating resource content: ${error}`);
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
        this.logger.warn(`Error sending streaming update: ${error}`);
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

  private async persistContextStats(sessionId: string): Promise<void> {
    const contextStats = this.contextMonitor.getStats(sessionId);
    if (!contextStats) return;
    
    try {
      const existingSession = await this.sessionPersistence.loadSession(sessionId);
      if (existingSession) {
        await this.sessionPersistence.saveSession({
          ...existingSession,
          contextStats: {
            estimatedTokens: contextStats.estimatedTokens,
            messages: contextStats.messages,
            turnCount: contextStats.turnCount,
            lastUpdate: contextStats.lastUpdate.toISOString()
          }
        });
      }
    } catch (error) {
      // Don't throw - this is a background operation
      this.logger.warn(`Context stats persistence failed: ${error}`, { sessionId });
    }
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
    
    this.logger.debug(`Batch ${batchId} tool ${toolCallId}: ${previousStatus} -> ${status}`);
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
        this.logger.warn(`Error sending batch update: ${error}`);
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
      this.logger.warn(`Error creating diff content: ${error}`);
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
      this.logger.warn(`Error detecting media content: ${error}`);
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
    
    this.logger.info(`Updated tool permissions`, { config });
  }

  /**
   * Get current tool permissions configuration
   */
  public getToolPermissions(): ToolPermissionConfig {
    return { ...this.toolPermissions };
  }

  /**
   * Cleanup stale streaming updates to prevent memory leaks
   */
  private cleanupStaleStreamingUpdates(): void {
    const now = Date.now();
    const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    let cleanedCount = 0;
    for (const [toolCallId, streaming] of this.streamingUpdates.entries()) {
      // Remove if too old (no activity for 30 minutes)
      if (now - (streaming.totalSize || 0) > STALE_THRESHOLD) {
        this.streamingUpdates.delete(toolCallId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} stale streaming updates`);
    }
  }

  /**
   * Cleanup stale batches to prevent memory leaks
   */
  private cleanupStaleBatches(): void {
    let cleanedCount = 0;
    for (const [batchId] of this.activeBatches.entries()) {
      // Remove completed batches
      const isComplete = this.isBatchComplete(batchId);
      
      if (isComplete) {
        this.activeBatches.delete(batchId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} stale batches`);
    }
  }

  /**
   * Cleanup method called on shutdown
   */
  destroy(): void {
    if (this.streamingCleanupTimer) {
      clearInterval(this.streamingCleanupTimer);
    }
    if (this.batchCleanupTimer) {
      clearInterval(this.batchCleanupTimer);
    }
    
    // Clear all Maps to free memory
    this.streamingUpdates.clear();
    this.activeBatches.clear();
    this.toolExecutionTiming.clear();
    
    this.logger.info('ACP Agent destroyed and cleaned up');
  }
}
