import { query } from "@anthropic-ai/claude-code";
import type { SDKMessage } from "@anthropic-ai/claude-code";
import { randomUUID } from 'crypto';
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
} from "@zed-industries/agent-client-protocol";
import type { ClaudeMessage } from "./types.js";
import { validateNewSessionRequest, validateLoadSessionRequest, validatePromptRequest } from "./types.js";
import { ContextMonitor } from "./context-monitor.js";
import { createLogger, type Logger } from "./logger.js";
import { CircuitBreaker, CLAUDE_SDK_CIRCUIT_OPTIONS } from './circuit-breaker.js';
import { globalResourceManager } from './resource-manager.js';
import { getGlobalErrorHandler, handleResourceError } from './error-handler.js';
import { getGlobalPerformanceMonitor, withPerformanceTracking } from './performance-monitor.js';

interface AgentSession {
  pendingPrompt: AsyncIterableIterator<SDKMessage> | null;
  abortController: AbortController | null;
  claudeSessionId?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
}

export class ClaudeACPAgent implements Agent {
  private sessions: Map<string, AgentSession> = new Map();
  private contextMonitor: ContextMonitor;
  private readonly logger: Logger;
  private maxTurns: number;
  private defaultPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  private pathToClaudeCodeExecutable: string | undefined;
  private claudeSDKCircuitBreaker: CircuitBreaker<{ prompt: string; options: Record<string, unknown> }, AsyncIterableIterator<SDKMessage>>;

  constructor(private client: Client) {
    // Validate configuration
    this.validateConfig();
    
    // Initialize global handlers
    getGlobalErrorHandler();
    getGlobalPerformanceMonitor();

    // Parse configuration
    this.maxTurns = this.parseMaxTurns();
    this.defaultPermissionMode = this.parsePermissionMode();
    this.pathToClaudeCodeExecutable = process.env.ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE;
    
    this.logger = createLogger('ClaudeACPAgent');
    this.contextMonitor = new ContextMonitor();
    this.claudeSDKCircuitBreaker = new CircuitBreaker(async (args) => query(args), CLAUDE_SDK_CIRCUIT_OPTIONS);
    
    this.logger.info(`Initialized ACP Agent - Max turns: ${this.maxTurns === 0 ? 'unlimited' : this.maxTurns}, Permission: ${this.defaultPermissionMode}`);
  }

  private validateConfig(): void {
    const maxTurns = process.env.ACP_MAX_TURNS;
    if (maxTurns && !/^\d+$/.test(maxTurns)) {
      throw new Error(`Invalid ACP_MAX_TURNS: "${maxTurns}" must be a positive integer`);
    }

    const permissionMode = process.env.ACP_PERMISSION_MODE;
    const validModes = ["default", "acceptEdits", "bypassPermissions", "plan"];
    if (permissionMode && !validModes.includes(permissionMode)) {
      throw new Error(`Invalid ACP_PERMISSION_MODE: "${permissionMode}". Must be one of: ${validModes.join(', ')}`);
    }
  }

  private parseMaxTurns(): number {
    const value = process.env.ACP_MAX_TURNS;
    if (!value) return 100;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 0) throw new Error(`Invalid ACP_MAX_TURNS: "${value}" must be a non-negative integer`);
    return parsed;
  }

  private parsePermissionMode(): "default" | "acceptEdits" | "bypassPermissions" | "plan" {
    const mode = process.env.ACP_PERMISSION_MODE;
    const validModes = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
    return validModes.includes(mode as typeof validModes[number]) ? (mode as typeof validModes[number]) : "default";
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.logger.debug(`Initialize with protocol version: ${params.protocolVersion}`);
    
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        }
      },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const validatedParams = validateNewSessionRequest(_params);
    this.logger.info("Creating new session", { cwd: validatedParams.cwd });
    
    if (!globalResourceManager.canStartOperation('new-session')) {
      handleResourceError('System resources exhausted - cannot create new session', { operation: 'newSession' });
    }

    const sessionId = randomUUID();
    
    if (!globalResourceManager.addSession(sessionId)) {
      throw new Error('Maximum concurrent sessions reached');
    }

    this.sessions.set(sessionId, {
      pendingPrompt: null,
      abortController: null,
      permissionMode: this.defaultPermissionMode,
    });

    this.logger.info(`Created session: ${sessionId}`);
    return { sessionId };
  }

  async loadSession?(params: LoadSessionRequest): Promise<void> {
    const validatedParams = validateLoadSessionRequest(params);
    this.logger.info(`Loading session: ${validatedParams.sessionId}`);

    // ACP doesn't support session persistence - sessions are memory-only
    if (this.sessions.has(validatedParams.sessionId)) {
      this.logger.debug(`Session ${validatedParams.sessionId} already exists in memory`);
      return;
    }

    this.logger.debug(`Session ${validatedParams.sessionId} not found - ACP sessions are memory-only`);
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    this.logger.debug("Authentication handled by Claude Code SDK");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const validatedParams = validatePromptRequest(params);
    const sessionId = validatedParams.sessionId;
    
    return withPerformanceTracking('prompt', async () => {
      const session = this.getSession(sessionId);

      if (session.pendingPrompt) {
        throw new Error(`Session is busy processing another prompt`);
      }

      // Cancel any pending operations
      if (session.abortController) {
        session.abortController.abort();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      session.abortController = new AbortController();

      const operationId = `prompt-${sessionId}-${Date.now()}`;
      if (!globalResourceManager.startOperation(operationId)) {
        throw new Error('System resources exhausted - cannot process prompt');
      }
      
      try {
        return await this.executePrompt(validatedParams, session, sessionId);
      } finally {
        globalResourceManager.finishOperation(operationId);
      }
    }, sessionId);
  }

  private async executePrompt(params: PromptRequest, session: AgentSession, sessionId: string): Promise<PromptResponse> {
    try {
      const promptText = params.prompt
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");

      // Track context usage
      const contextWarning = this.contextMonitor.addMessage(sessionId, promptText);
      if (contextWarning) {
        await this.sendContextWarning(sessionId, contextWarning);
      }

      // Handle permission mode switching
      session.permissionMode = this.parsePromptPermissionMode(promptText, session.permissionMode);

      // Prepare query options
      const queryOptions: Record<string, unknown> = {
        permissionMode: session.permissionMode,
        pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
        resume: session.claudeSessionId,
      };
      
      if (this.maxTurns > 0) {
        queryOptions.maxTurns = this.maxTurns;
      }

      // Send thinking indicator
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "🤔 Thinking..." },
        },
      });
      
      const messages = await this.claudeSDKCircuitBreaker.execute({
        prompt: promptText,
        options: queryOptions,
      });

      session.pendingPrompt = messages as AsyncIterableIterator<SDKMessage>;

      // Process messages
      for await (const message of messages) {
        if (session.abortController?.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        const sdkMessage = message as SDKMessage;
        
        // Extract Claude session ID
        if ("session_id" in sdkMessage && typeof sdkMessage.session_id === "string") {
          session.claudeSessionId = sdkMessage.session_id;
        }

        await this.handleMessage(sessionId, message as ClaudeMessage);
      }

      session.pendingPrompt = null;
      return { stopReason: "end_turn" };
      
    } catch (error) {
      if (session.abortController?.signal.aborted) {
        return { stopReason: "cancelled" };
      }

      await this.sendErrorMessage(sessionId, error);
      return { stopReason: "end_turn" };
    } finally {
      session.pendingPrompt = null;
      session.abortController = null;
    }
  }

  private parsePromptPermissionMode(promptText: string, currentMode?: string): "default" | "acceptEdits" | "bypassPermissions" | "plan" {
    if (promptText.includes("[ACP:PERMISSION:ACCEPT_EDITS]")) return "acceptEdits";
    if (promptText.includes("[ACP:PERMISSION:BYPASS]")) return "bypassPermissions";
    if (promptText.includes("[ACP:PERMISSION:DEFAULT]")) return "default";
    return (currentMode || this.defaultPermissionMode) as "default" | "acceptEdits" | "bypassPermissions" | "plan";
  }

  private async sendContextWarning(sessionId: string, warning: { usage?: number; level?: string }): Promise<void> {
    const usagePercent = Math.round((warning.usage || 0) * 100);
    const text = warning.level === 'critical' 
      ? `Context near limit (${usagePercent}%) - consider new session`
      : `Context usage: ${usagePercent}%`;
      
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async sendErrorMessage(sessionId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isCircuitBreaker = errorMessage.includes('Circuit breaker is OPEN');
    
    const text = isCircuitBreaker
      ? `⏳ Service temporarily unavailable - retrying automatically`
      : `❌ Error: ${errorMessage}`;
      
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async handleMessage(sessionId: string, message: ClaudeMessage): Promise<void> {
    const messageType = "type" in message ? message.type : undefined;

    switch (messageType) {
      case "assistant":
        if (message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === "text") {
              const text = content.text || "";
              this.contextMonitor.addMessage(sessionId, text);
              
              await this.client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text },
                },
              });
            } else if (content.type === "tool_use") {
              await this.handleToolUse(sessionId, content);
            }
          }
        }
        break;

      case "text":
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: message.text || "" },
          },
        });
        break;

      case "tool_use_start":
        await this.handleToolStart(sessionId, message);
        break;

      case "tool_use_output":
        await this.handleToolOutput(sessionId, message);
        break;

      case "tool_use_error":
        await this.handleToolError(sessionId, message);
        break;
    }
  }

  private async handleToolUse(sessionId: string, content: { id?: string; name?: string; input?: Record<string, unknown> }): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: content.id || "",
        title: content.name || "Tool",
        kind: this.mapToolKind(content.name || ""),
        status: "pending",
        rawInput: content.input as Record<string, unknown>,
      },
    });
  }

  private async handleToolStart(sessionId: string, msg: ClaudeMessage): Promise<void> {
    const toolTitle = this.getToolTitle(msg.tool_name || "Tool", msg.input);
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: msg.id || "",
        title: toolTitle,
        kind: this.mapToolKind(msg.tool_name || ""),
        status: "pending",
        rawInput: msg.input as Record<string, unknown>,
      },
    });

    // Send in_progress after small delay
    setTimeout(async () => {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: msg.id || "",
          status: "in_progress",
          content: [{
            type: "content",
            content: { type: "text", text: `Executing ${toolTitle}...` }
          }]
        },
      });
    }, 100);
  }

  private async handleToolOutput(sessionId: string, msg: ClaudeMessage): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: msg.id || "",
        status: "completed",
        content: [{
          type: "content",
          content: { type: "text", text: msg.output || "" },
        }],
        rawOutput: msg.output ? { output: msg.output } : undefined,
      },
    });
  }

  private async handleToolError(sessionId: string, msg: ClaudeMessage): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: msg.id || "",
        status: "failed",
        content: [{
          type: "content",
          content: { type: "text", text: `Error: ${msg.error}` },
        }],
        rawOutput: { error: msg.error },
      },
    });
  }

  private getToolTitle(toolName: string, input?: unknown): string {
    if (input && typeof input === 'object' && input !== null) {
      const inputObj = input as Record<string, unknown>;
      
      if (inputObj.file_path) {
        const filename = String(inputObj.file_path).split('/').pop();
        return `${toolName}: ${filename}`;
      }
      
      if (inputObj.command) {
        return `${toolName}: ${String(inputObj.command)}`;
      }
    }
    
    return toolName;
  }

  private mapToolKind(toolName: string): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other" {
    const lowerName = toolName.toLowerCase();
    
    // Read operations
    if (lowerName.includes("read") || lowerName.includes("glob") || lowerName.includes("ls") || 
        lowerName.includes("cat") || lowerName.includes("view")) return "read";
    
    // Edit operations
    if (lowerName.includes("write") || lowerName.includes("edit") || lowerName.includes("create") ||
        lowerName.includes("update") || lowerName.includes("modify")) return "edit";
    
    // Delete operations
    if (lowerName.includes("delete") || lowerName.includes("remove") || lowerName.includes("rm")) return "delete";
    
    // Move operations
    if (lowerName.includes("move") || lowerName.includes("mv") || lowerName.includes("rename")) return "move";
    
    // Search operations
    if (lowerName.includes("grep") || lowerName.includes("search") || lowerName.includes("find") ||
        lowerName.includes("rg") || lowerName.includes("ripgrep")) return "search";
    
    // Execute operations
    if (lowerName.includes("bash") || lowerName.includes("execute") || lowerName.includes("run") ||
        lowerName.includes("command") || lowerName.includes("shell")) return "execute";
    
    // Think operations
    if (lowerName.includes("todo") || lowerName.includes("plan") || lowerName.includes("think") ||
        lowerName.includes("analyze")) return "think";
    
    // Fetch operations
    if (lowerName.includes("fetch") || lowerName.includes("web") || lowerName.includes("http") ||
        lowerName.includes("download")) return "fetch";
    
    return "other";
  }

  private getSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.logger.debug(`Cancel requested for session: ${params.sessionId}`);
    const session = this.sessions.get(params.sessionId);
    if (session?.abortController) {
      session.abortController.abort();
      session.pendingPrompt = null;
    }
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
    }
    this.sessions.clear();
    this.contextMonitor.destroy();
    this.logger.info('ACP Agent destroyed');
  }
}