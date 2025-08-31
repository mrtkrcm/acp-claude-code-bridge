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
import type { ClaudeMessage, ClaudeStreamEvent } from "./types.js";
import { ContextMonitor } from "./context-monitor.js";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

interface AgentSession {
  pendingPrompt: AsyncIterableIterator<SDKMessage> | null;
  abortController: AbortController | null;
  claudeSessionId?: string; // Claude's actual session_id, obtained after first message
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"; // Permission mode for this session
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
    this.initializeLogging();
    
    this.log(`Initialized ACP Agent - Max turns: ${this.maxTurns === 0 ? 'unlimited' : this.maxTurns}, Permission: ${this.defaultPermissionMode}`);
    
    // Enhanced session cleanup with logging
    setInterval(() => {
      const cleanedCount = this.contextMonitor.cleanupOldSessions();
      if (cleanedCount > 0) {
        this.log(`Cleaned up ${cleanedCount} old context sessions`);
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

  private log(message: string, ...args: unknown[]) {
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] [DEBUG] [ClaudeACPAgent] ${message}`;
    const argsStr = args.length > 0 ? ` ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')}` : '';
    
    if (this.DEBUG) {
      console.error(fullMessage + argsStr);
    }
    
    // Log to file if configured
    if (this.fileLogger) {
      this.fileLogger.write(fullMessage + argsStr + '\n');
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.log(`Initialize with protocol version: ${params.protocolVersion}`);
    this.log(`Client capabilities: ${JSON.stringify(params.clientCapabilities || {})}`);

    // Store client capabilities for direct operations
    this.clientCapabilities = params.clientCapabilities || {};
    this.log(`File system capabilities: readTextFile=${this.clientCapabilities.fs?.readTextFile}, writeTextFile=${this.clientCapabilities.fs?.writeTextFile}`);
    this.log(`Permission system: ACP supports native permission dialogs=${!!this.client.requestPermission}`);

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true, // Enable session loading
      },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.log("Creating new session");

    // For now, create a temporary session ID
    // We'll get the real Claude session_id on the first message
    // and store it for future use
    const sessionId = Math.random().toString(36).substring(2);

    this.sessions.set(sessionId, {
      pendingPrompt: null,
      abortController: null,
      claudeSessionId: undefined, // Will be set after first message
      permissionMode: this.defaultPermissionMode,
    });

    this.log(`Created session: ${sessionId}`);

    return {
      sessionId,
    };
  }

  async loadSession?(params: LoadSessionRequest): Promise<void> {
    this.log(`Loading session: ${params.sessionId}`);

    // Check if we already have this session
    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      this.log(
        `Session ${params.sessionId} already exists with Claude session_id: ${existingSession.claudeSessionId}`,
      );
      // Keep the existing session with its Claude session_id intact
      return; // Return null to indicate success
    }

    // Create a new session entry for this ID if it doesn't exist
    // This handles the case where the agent restarts but Zed still has the session ID
    this.sessions.set(params.sessionId, {
      pendingPrompt: null,
      abortController: null,
      claudeSessionId: undefined,
      permissionMode: this.defaultPermissionMode,
    });

    this.log(
      `Created new session entry for loaded session: ${params.sessionId}`,
    );
    return; // Return null to indicate success
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    this.log("Authenticate called");
    // Claude Code SDK handles authentication internally through ~/.claude/config.json
    // Users should run `claude setup-token` or login through the CLI
    this.log("Using Claude Code authentication from ~/.claude/config.json");
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

    this.log(`Processing prompt for session: ${currentSessionId}`);
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
        this.log(`Context warning: ${contextWarning.message}`);
        
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
        this.log(`Resuming Claude session: ${session.claudeSessionId}`);
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

      this.log(`Using permission mode: ${permissionMode}`);

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
      
      this.log(`Starting query with${this.maxTurns === 0 ? ' unlimited' : ` ${this.maxTurns}`} turns`);
      
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
              this.log(`Turn warning: ${turnCount}/${this.maxTurns} turns used`);
              
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
            this.log(`Unlimited session progress: ${turnCount} turns completed`);
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
          this.log(`Processing user message`);
        } else if (sdkMessage.type === "assistant") {
          this.log(`Processing assistant message`);
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

      this.log(`Processed ${messageCount} messages total`);
      this.log(`Final Claude session_id: ${session.claudeSessionId}`);
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
        this.log(`Error occurred at context usage: ${(contextStats.usage * 100).toFixed(1)}%`);
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
    this.log(`Cancel requested for session: ${params.sessionId}`);

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
              this.log(`Tool result received for: ${content.tool_use_id}`);
              
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
                this.log(`Critical context usage detected: ${assistantContextWarning.message}`);
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
              
              await this.client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: content.id || "",
                  title: toolTitle,
                  kind: this.mapToolKind(content.name || ""),
                  status: "pending",
                  rawInput: content.input as Record<string, unknown>,
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
          this.log(`Tool location: ${toolLocation.path}${toolLocation.line ? `:${toolLocation.line}` : ''}`);
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
        this.log(`Tool call completed: ${msg.id}`);
        this.log(`Tool output length: ${outputText.length} characters`);

        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: msg.id || "",
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: outputText,
                },
              },
            ],
            // Pass output directly without extra wrapping
            rawOutput: msg.output ? { output: outputText } : undefined,
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
          this.log("Content block stopped");
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
      this.log(`\u2705 Bypassing permission request for ${operation} (mode: ${permissionMode})`);
      return 'allowed';
    }

    if (permissionMode === 'acceptEdits') {
      // More granular control for acceptEdits mode
      if (toolCall.kind === 'execute' || operation.toLowerCase().includes('bash')) {
        this.log(`\u26a0\ufe0f Execute operation requires explicit permission even in acceptEdits mode`);
        // Continue to permission dialog
      } else {
        this.log(`\u2705 Auto-accepting ${toolCall.kind} operation: ${operation} (mode: ${permissionMode})`);
        return 'allowed';
      }
    }

    // Use ACP native permission dialog if available
    if (this.client.requestPermission) {
      this.log(`Requesting ACP permission for: ${operation}`);
      
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
          this.log(`Permission request cancelled for: ${operation}`);
          return 'cancelled';
        } else if (response.outcome.outcome === 'selected') {
          const selectedOption = response.outcome.optionId;
          this.log(`Permission ${selectedOption} for: ${operation}`);
          
          // Enhanced permission mode updating based on user choice
          if (session) {
            if (selectedOption === 'always') {
              session.permissionMode = 'acceptEdits';
              this.log(`\u2699\ufe0f Updated session to acceptEdits mode for future ${toolCall.kind} operations`);
            } else if (selectedOption === 'session') {
              // Create a session-specific allowlist (extend AgentSession interface if needed)
              session.permissionMode = 'acceptEdits'; // For now, treat as acceptEdits
              this.log(`\ud83d\udcdd Session permission granted for ${toolCall.kind} operations`);
            }
          }
          
          const allowed = ['allow', 'always', 'session'].includes(selectedOption);
          this.log(`Permission ${allowed ? 'GRANTED' : 'DENIED'} for: ${operation}`);
          return allowed ? 'allowed' : 'denied';
        }
      } catch (error) {
        this.log(`ACP permission request failed: ${error}`, 'ERROR');
        // Fall through to default behavior
      }
    }

    // Fallback: Check permission mode for default behavior
    if (permissionMode === 'plan') {
      this.log(`Plan mode - denying ${operation} for review`);
      return 'denied';
    }

    // Default mode - allow (matches Claude's default behavior)
    this.log(`Default permission granted for: ${operation}`);
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
          this.log(`Invalid file path for ACP readTextFile: "${filePath}"`);
          return false;
        }

        this.log(`Using ACP direct readTextFile for: ${filePath}`);

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

        this.log(`ACP readTextFile completed: ${response.content.length} characters from ${filePath}`);
        return true;
      }

      // Handle Write operations with ACP writeTextFile  
      if (lowerToolName === 'write' && this.clientCapabilities.fs?.writeTextFile && inputObj.file_path && inputObj.content) {
        // Validate file path and content
        const filePath = String(inputObj.file_path).trim();
        const content = String(inputObj.content);
        
        if (!filePath || filePath.length === 0) {
          this.log(`Invalid file path for ACP writeTextFile: "${filePath}"`);
          return false;
        }

        this.log(`Using ACP direct writeTextFile for: ${filePath} (${content.length} chars)`);

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

        this.log(`ACP writeTextFile completed: ${content.length} characters to ${filePath}`);
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
   * Based on permission mode and tool sensitivity.
   */
  private async shouldRequestPermissionForTool(
    sessionId: string,
    toolName: string,
    _input: unknown
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const permissionMode = session?.permissionMode || this.defaultPermissionMode;

    // Skip permission requests in certain modes
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
      this.log(`Cleaned up ${cleanedCount} orphaned agent sessions`);
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
}
