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
import type { 
  ClaudeMessage, 
  PlanEntry, 
  ToolCallLocation, 
  ToolCallContent,
  PermissionOption,
  ACPRequestPermissionRequest,
  ACPContentBlock,
  ACPAnnotations,
  ToolOperationContext,
  EnhancedPromptCapabilities
} from "./types.js";
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
  // Enhanced ACP features
  currentPlan?: PlanEntry[];
  activeFiles?: Set<string>;
  thoughtStreaming?: boolean;
  createdAt: number;
  lastActivityAt: number;
  operationContext?: Map<string, ToolOperationContext>;
}

export class ClaudeACPAgent implements Agent {
  private sessions: Map<string, AgentSession> = new Map();
  private contextMonitor: ContextMonitor;
  private readonly logger: Logger;
  private maxTurns: number;
  private defaultPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  private pathToClaudeCodeExecutable: string | undefined;
  private claudeSDKCircuitBreaker: CircuitBreaker<{ prompt: string; options: Record<string, unknown> }, AsyncIterableIterator<SDKMessage>>;
  
  // Enhanced ACP capabilities
  private readonly enhancedCapabilities: EnhancedPromptCapabilities = {
    audio: false,
    embeddedContext: true,
    image: true,
    plans: true,
    thoughtStreaming: true
  };
  
  // Performance constants
  private static readonly PROMPT_COMPLEXITY_THRESHOLD = 200;
  private static readonly MAX_ACTIVE_FILES_PER_SESSION = 100;
  private static readonly PLAN_UPDATE_DEBOUNCE = 500; // ms
  private static readonly THOUGHT_STREAM_ENABLED = true;

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
    
    // Enhanced startup logging inspired by Gemini CLI
    this.logStartupConfiguration();
    this.logger.info(`Initialized ACP Agent - Max turns: ${this.maxTurns === 0 ? 'unlimited' : this.maxTurns}, Permission: ${this.defaultPermissionMode}`);
  }

  /**
   * Logs startup configuration for transparency (inspired by Gemini CLI)
   */
  private logStartupConfiguration(): void {
    this.logger.info('=== ACP Bridge Startup Configuration ===');
    this.logger.info(`Permission Mode: ${this.defaultPermissionMode} ${this.getPermissionModeSource()}`);
    this.logger.info(`Max Turns: ${this.maxTurns === 0 ? 'unlimited' : this.maxTurns} ${this.getMaxTurnsSource()}`);
    this.logger.info(`Debug Mode: ${process.env.ACP_DEBUG === 'true' ? 'enabled' : 'disabled'}`);
    this.logger.info(`Log File: ${process.env.ACP_LOG_FILE || 'console only'}`);
    this.logger.info(`Context Monitoring: active (200k token limit)`);
    this.logger.info(`Circuit Breaker: enabled (Claude SDK protection)`);
    this.logger.info('========================================');
  }

  private getPermissionModeSource(): string {
    if (process.env.ACP_PERMISSION_MODE) return '(from ACP_PERMISSION_MODE)';
    return '(default)';
  }

  private getMaxTurnsSource(): string {
    if (process.env.ACP_MAX_TURNS) return '(from ACP_MAX_TURNS)';
    return '(default)';
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
          image: this.enhancedCapabilities.image,
          audio: this.enhancedCapabilities.audio,
          embeddedContext: this.enhancedCapabilities.embeddedContext
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

    const now = Date.now();
    this.sessions.set(sessionId, {
      pendingPrompt: null,
      abortController: null,
      permissionMode: this.defaultPermissionMode,
      // Enhanced session features
      activeFiles: new Set(),
      thoughtStreaming: ClaudeACPAgent.THOUGHT_STREAM_ENABLED,
      createdAt: now,
      lastActivityAt: now,
      operationContext: new Map(),
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
    let operationId: string | undefined;
    
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
      const previousPermissionMode = session.permissionMode;
      session.permissionMode = this.parsePromptPermissionMode(promptText, session.permissionMode);
      
      // Report bypass mode at first prompt or when mode changes
      if (session.permissionMode === "bypassPermissions" && previousPermissionMode !== "bypassPermissions") {
        await this.reportBypassMode(sessionId);
      }

      // Prepare query options
      const queryOptions: Record<string, unknown> = {
        permissionMode: session.permissionMode,
        pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
        resume: session.claudeSessionId,
      };
      
      if (this.maxTurns > 0) {
        queryOptions.maxTurns = this.maxTurns;
      }

      // Analyze prompt complexity for enhanced features
      const complexity = this.analyzePromptComplexity(promptText);
      session.lastActivityAt = Date.now();
      
      // Send agent thought if thought streaming enabled and complex
      if (session.thoughtStreaming && complexity.isComplex) {
        await this.sendAgentThought(sessionId, `Analyzing request: ${complexity.summary}`);
      }
      
      // Generate and send execution plan for complex operations
      if (complexity.needsPlan) {
        await this.generateAndSendPlan(sessionId, complexity);
      }
      
      // Remove thinking message - start processing directly
      
      // Resource management for message processing
      operationId = `claude-query-${sessionId}-${Date.now()}`;
      if (!globalResourceManager.startOperation(operationId)) {
        throw new Error('System resources exhausted - cannot execute Claude query');
      }
      
      let messages;
      
      try {
        messages = await this.claudeSDKCircuitBreaker.execute({
          prompt: promptText,
          options: queryOptions,
        });
        
        // Keep operation active during message processing
      } catch (error) {
        globalResourceManager.finishOperation(operationId);
        throw error;
      }

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
      if (operationId) {
        globalResourceManager.finishOperation(operationId);
      }
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
      ? `[RETRY] Service temporarily unavailable - retrying automatically`
      : `[ERROR] Error: ${errorMessage}`;
      
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
    const toolName = content.name || "Tool";
    const status = "pending";
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: content.id || "",
        title: this.enhanceToolTitle(sessionId, toolName, status),
        kind: this.mapToolKind(toolName),
        status,
        rawInput: content.input as Record<string, unknown>,
      },
    });
  }

  private async handleToolStart(sessionId: string, msg: ClaudeMessage): Promise<void> {
    const toolName = msg.tool_name || "Tool";
    const toolCallId = msg.id || "";
    const session = this.getSession(sessionId);
    
    // Enhanced tool context analysis
    const operationContext = this.analyzeToolOperation(toolName, msg.input);
    session.operationContext?.set(toolCallId, operationContext);
    
    // Extract file locations for follow-along features
    const locations = this.extractToolLocations(operationContext);
    
    // Track active files
    if (session.activeFiles && session.activeFiles.size < ClaudeACPAgent.MAX_ACTIVE_FILES_PER_SESSION) {
      locations.forEach(loc => session.activeFiles!.add(loc.path));
    }
    
    // Enhanced tool title with context
    const enhancedTitle = this.generateEnhancedToolTitle(operationContext);
    
    // Send agent thought for complex operations
    if (session.thoughtStreaming && operationContext.complexity === "complex") {
      await this.sendAgentThought(sessionId, `Starting ${operationContext.operationType} operation on ${operationContext.affectedFiles?.join(', ') || 'file'}`);
    }
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: this.enhanceToolTitle(sessionId, enhancedTitle, "pending", operationContext.operationType),
        kind: this.mapToolKind(toolName),
        status: "pending",
        rawInput: msg.input as Record<string, unknown>,
        locations,
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
            content: { type: "text", text: `${this.enhanceToolTitle(sessionId, "Executing", "in_progress")} ${enhancedTitle}...` }
          }]
        },
      });
    }, 100);
  }

  private async handleToolOutput(sessionId: string, msg: ClaudeMessage): Promise<void> {
    const toolCallId = msg.id || "";
    const session = this.getSession(sessionId);
    const operationContext = session.operationContext?.get(toolCallId);
    
    // Generate enhanced tool content with diff support
    const enhancedContent = this.generateEnhancedToolContent(
      operationContext || { toolName: "Tool", input: msg.input },
      msg.output || ""
    );
    
    // Send agent thought for completion
    if (session.thoughtStreaming && operationContext?.complexity === "complex") {
      await this.sendAgentThought(sessionId, `Completed ${operationContext.operationType} operation successfully`);
    }
    
    // Update plan progress if operation was part of a plan
    if (session.currentPlan && operationContext) {
      await this.updatePlanForToolCompletion(sessionId, operationContext);
    }
    
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: enhancedContent,
        rawOutput: msg.output ? { output: msg.output } : undefined,
      },
    });
    
    // Cleanup context
    session.operationContext?.delete(toolCallId);
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
          content: { type: "text", text: `${this.enhanceToolTitle(sessionId, "Error", "failed")}: ${msg.error}` },
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

  // ============================================================================
  // ENHANCED ACP FEATURE IMPLEMENTATIONS
  // ============================================================================
  
  /**
   * Analyzes prompt complexity for plan generation and thought streaming
   */
  private analyzePromptComplexity(prompt: string): {
    isComplex: boolean;
    needsPlan: boolean;
    summary: string;
    estimatedSteps: number;
  } {
    const lowerPrompt = prompt.toLowerCase();
    
    // Complex operation indicators
    const complexKeywords = ['implement', 'create', 'build', 'refactor', 'restructure', 'migrate', 'optimize'];
    const multiStepIndicators = ['first', 'then', 'next', 'after', 'finally', 'step', 'phase'];
    
    const hasComplexKeywords = complexKeywords.some(kw => lowerPrompt.includes(kw));
    const hasMultiStepIndicators = multiStepIndicators.some(ind => lowerPrompt.includes(ind));
    const isLongPrompt = prompt.length > ClaudeACPAgent.PROMPT_COMPLEXITY_THRESHOLD;
    
    const isComplex = hasComplexKeywords || hasMultiStepIndicators || isLongPrompt;
    const needsPlan = isComplex && (hasMultiStepIndicators || isLongPrompt || complexKeywords.filter(kw => lowerPrompt.includes(kw)).length > 1);
    
    // Estimate steps based on complexity indicators
    let estimatedSteps = 1;
    if (hasMultiStepIndicators) estimatedSteps += 2;
    if (hasComplexKeywords) estimatedSteps += 1;
    if (isLongPrompt) estimatedSteps += 1;
    
    const summary = this.generatePromptSummary(prompt, isComplex);
    
    return { isComplex, needsPlan, summary, estimatedSteps };
  }
  
  /**
   * Generates a concise summary of the prompt
   */
  private generatePromptSummary(prompt: string, isComplex: boolean): string {
    if (!isComplex) return "Processing simple request";
    
    const words = prompt.split(/\s+/);
    if (words.length <= 15) return prompt;
    
    const firstSentence = prompt.split(/[.!?]/)[0];
    return firstSentence.length <= 100 ? firstSentence : firstSentence.substring(0, 97) + '...';
  }
  
  /**
   * Generates and sends execution plan for complex operations
   */
  private async generateAndSendPlan(sessionId: string, complexity: { summary: string; estimatedSteps: number }): Promise<void> {
    const session = this.getSession(sessionId);
    const plan: PlanEntry[] = [];
    
    // Generate plan entries based on complexity
    if (complexity.estimatedSteps >= 3) {
      plan.push({
        content: "Analyze requirements and approach",
        priority: "high",
        status: "in_progress"
      });
      plan.push({
        content: "Execute main implementation",
        priority: "high", 
        status: "pending"
      });
      plan.push({
        content: "Validate and finalize changes",
        priority: "medium",
        status: "pending"
      });
    } else {
      plan.push({
        content: complexity.summary,
        priority: "high",
        status: "in_progress"
      });
    }
    
    session.currentPlan = plan;
    await this.sendPlanUpdate(sessionId, plan);
  }
  
  /**
   * Sends plan update to client with mode indicators
   */
  private async sendPlanUpdate(sessionId: string, entries: PlanEntry[]): Promise<void> {
    // Add mode indicators to the first entry title if entries exist
    const enhancedEntries = entries.length > 0 ? [
      {
        ...entries[0],
        title: this.addModeIndicators(sessionId, entries[0].title),
      },
      ...entries.slice(1)
    ] : entries;

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: enhancedEntries
      }
    });
  }

  /**
   * Adds comprehensive mode indicators to title if not already present
   */
  private addModeIndicators(sessionId: string, title?: string): string {
    const session = this.getSession(sessionId);
    const indicators: string[] = [];
    
    // Always add plan mode indicator (we're in plan mode if this is called)
    indicators.push("⏸ plan mode");
    
    // Permission mode indicators - removed from here, only shown at start
    
    // Debug mode indicator
    if (process.env.ACP_DEBUG === "true") {
      indicators.push("[DEBUG] debug mode");
    }
    
    // Session type indicator (loaded vs new)
    if (session.claudeSessionId) {
      indicators.push("[RESUME] resumed session");
    }
    
    // Tool execution status (if tools are running)
    if (session.operationContext && session.operationContext.size > 0) {
      indicators.push("[TOOLS] tools active");
    }
    
    // Max turns indicator (if limited)
    if (this.maxTurns > 0) {
      indicators.push(`[TURNS] max-turns:${this.maxTurns}`);
    }
    
    const indicatorString = indicators.join(" ");
    
    if (!title) {
      return indicatorString; // Return indicators without dash if no existing title
    }
    
    // Check if any indicators are already present
    if (indicators.some(indicator => title.includes(indicator.split(" ")[1] || indicator))) {
      return title; // Already has indicators
    }
    
    return `${indicatorString} - ${title}`;
  }

  /**
   * Enhances tool titles with status indicators
   */
  private enhanceToolTitle(sessionId: string, baseTitle: string, status: "pending" | "in_progress" | "completed" | "failed", operationType?: string): string {
    const session = this.getSession(sessionId);
    const indicators: string[] = [];
    
    // Permission indicators removed - only shown at session start
    
    if (indicators.length === 0) {
      return baseTitle; // No indicators to add
    }
    
    const indicatorString = indicators.join(" ");
    
    // Check if indicators already present
    if (indicators.some(indicator => baseTitle.includes(indicator))) {
      return baseTitle; // Already enhanced
    }
    
    return `${indicatorString} - ${baseTitle}`;
  }

  /**
   * Determines if operation is non-readonly (modifies data/state)
   */
  private isNonReadonlyOperation(operationType?: string, baseTitle?: string): boolean {
    // Check explicit operation type first
    if (operationType) {
      const nonReadonlyTypes = ["create", "edit", "delete", "move", "execute"];
      return nonReadonlyTypes.includes(operationType);
    }
    
    // Fallback to title analysis for operations without explicit type
    if (baseTitle) {
      const title = baseTitle.toLowerCase();
      // Non-readonly patterns
      if (title.includes('write') || title.includes('create') || title.includes('edit') || 
          title.includes('delete') || title.includes('move') || title.includes('execute') ||
          title.includes('bash') || title.includes('run') || title.includes('modify')) {
        return true;
      }
      // Readonly patterns  
      if (title.includes('read') || title.includes('search') || title.includes('grep') ||
          title.includes('find') || title.includes('view') || title.includes('cat')) {
        return false;
      }
    }
    
    // Default to non-readonly for safety (show bypass indicators when uncertain)
    return true;
  }

  /**
   * Reports bypass mode activation to user
   */
  private async reportBypassMode(sessionId: string): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "⏵⏵ bypass mode active - permissions will be bypassed for file operations"
        }
      }
    });
  }
  
  /**
   * Sends agent thought chunk for transparency
   */
  private async sendAgentThought(sessionId: string, thought: string): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: thought }
      }
    });
  }
  
  /**
   * Analyzes tool operation for enhanced context
   */
  private analyzeToolOperation(toolName: string, input: unknown): ToolOperationContext {
    const inputObj = this.isValidInput(input) ? input : {};
    const lowerName = toolName.toLowerCase();
    
    // Determine operation type
    let operationType: ToolOperationContext['operationType'] = "other";
    if (lowerName.includes('read') || lowerName.includes('view') || lowerName.includes('cat')) operationType = "read";
    else if (lowerName.includes('write') || lowerName.includes('create')) operationType = "create";
    else if (lowerName.includes('edit') || lowerName.includes('modify')) operationType = "edit";
    else if (lowerName.includes('delete') || lowerName.includes('remove')) operationType = "delete";
    else if (lowerName.includes('move') || lowerName.includes('rename')) operationType = "move";
    else if (lowerName.includes('search') || lowerName.includes('grep') || lowerName.includes('find')) operationType = "search";
    else if (lowerName.includes('execute') || lowerName.includes('bash') || lowerName.includes('run')) operationType = "execute";
    
    // Extract affected files
    const affectedFiles: string[] = [];
    if (inputObj.file_path) affectedFiles.push(String(inputObj.file_path));
    if (Array.isArray(inputObj.files)) {
      affectedFiles.push(...inputObj.files.map(f => typeof f === 'string' ? f : String(f.path || f)));
    }
    
    // Determine complexity
    let complexity: ToolOperationContext['complexity'] = "simple";
    if (affectedFiles.length > 3) complexity = "complex";
    else if (operationType === "execute" || operationType === "delete") complexity = "moderate";
    else if (affectedFiles.length > 1) complexity = "moderate";
    
    return {
      toolName,
      input,
      operationType,
      affectedFiles: affectedFiles.length > 0 ? affectedFiles : undefined,
      complexity
    };
  }
  
  /**
   * Type guard for valid input objects
   */
  private isValidInput(input: unknown): input is Record<string, unknown> {
    return input !== null && typeof input === 'object' && !Array.isArray(input);
  }
  
  /**
   * Extracts file locations from tool operation context
   */
  private extractToolLocations(context: ToolOperationContext): ToolCallLocation[] {
    const locations: ToolCallLocation[] = [];
    
    if (context.affectedFiles) {
      for (const filePath of context.affectedFiles) {
        const location: ToolCallLocation = { path: filePath };
        
        // Try to extract line number from input
        if (this.isValidInput(context.input)) {
          const inputObj = context.input;
          if (typeof inputObj.line === 'number') location.line = inputObj.line;
          else if (typeof inputObj.offset === 'number') location.line = inputObj.offset;
        }
        
        locations.push(location);
      }
    }
    
    return locations;
  }
  
  /**
   * Generates enhanced tool title with context
   */
  private generateEnhancedToolTitle(context: ToolOperationContext): string {
    const { operationType, affectedFiles, toolName } = context;
    
    if (affectedFiles && affectedFiles.length > 0) {
      const action = operationType ? operationType.charAt(0).toUpperCase() + operationType.slice(1) : toolName;
      
      // For read and write operations, show full file path
      if (operationType === "read" || operationType === "create" || operationType === "edit") {
        const filePath = affectedFiles[0];
        
        if (affectedFiles.length === 1) {
          return `${action}: ${filePath}`;
        } else {
          const fileName = filePath.split('/').pop() || filePath;
          return `${action}: ${fileName} (+${affectedFiles.length - 1} files)`;
        }
      } else {
        // For other operations, show just filename to keep titles concise
        const fileName = affectedFiles[0].split('/').pop() || affectedFiles[0];
        
        if (affectedFiles.length === 1) {
          return `${action}: ${fileName}`;
        } else {
          return `${action}: ${fileName} (+${affectedFiles.length - 1} files)`;
        }
      }
    }
    
    // Enhanced titles for non-file operations
    if (this.isValidInput(context.input)) {
      const inputObj = context.input;
      
      if (inputObj.command) {
        const cmd = String(inputObj.command);
        const shortCmd = cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
        return `Execute: ${shortCmd}`;
      }
      
      if (inputObj.pattern || inputObj.query) {
        const term = String(inputObj.pattern || inputObj.query);
        const shortTerm = term.length > 25 ? term.substring(0, 22) + '...' : term;
        return `Search: "${shortTerm}"`;
      }
      
      if (inputObj.url) {
        const url = String(inputObj.url);
        try {
          const domain = new URL(url).hostname;
          return `Fetch: ${domain}`;
        } catch {
          return `Fetch: ${url.substring(0, 30)}...`;
        }
      }
    }
    
    return toolName;
  }
  
  /**
   * Generates enhanced tool content with diff support
   */
  private generateEnhancedToolContent(context: ToolOperationContext, output: string): ToolCallContent[] {
    const { operationType, affectedFiles } = context;
    
    // Generate diff content for file operations
    if ((operationType === "edit" || operationType === "create") && 
        affectedFiles && affectedFiles.length === 1 &&
        this.isValidInput(context.input)) {
      
      const inputObj = context.input;
      const filePath = affectedFiles[0];
      
      // Check for edit operations with old/new content
      if (inputObj.old_string && inputObj.new_string) {
        return [{
          type: "diff",
          path: filePath,
          oldText: String(inputObj.old_string),
          newText: String(inputObj.new_string)
        }];
      }
      
      // Check for file creation
      if (operationType === "create" && inputObj.content) {
        return [{
          type: "diff",
          path: filePath,
          oldText: null,
          newText: String(inputObj.content)
        }];
      }
    }
    
    // Enhanced text content with formatting and annotations
    const formattedOutput = this.formatToolOutput(context, output);
    const annotations = this.generateContentAnnotations(context, output);
    
    return [{
      type: "content",
      content: { 
        type: "text", 
        text: formattedOutput,
        annotations: annotations.text ? annotations : undefined
      }
    }];
  }
  
  /**
   * Formats error output with clean, readable formatting
   */
  private formatErrorOutput(context: ToolOperationContext, error: string | Error, errorCode?: string): string {
    const { toolName, affectedFiles } = context;
    const filePath = affectedFiles && affectedFiles[0] ? affectedFiles[0] : '';
    const multipleFiles = affectedFiles && affectedFiles.length > 1 ? ` (+${affectedFiles.length - 1} files)` : '';
    
    const errorMessage = error instanceof Error ? error.message : error;
    const errorName = error instanceof Error ? error.name : 'Error';
    const code = errorCode || (error instanceof Error && 'code' in error ? error.code as string : '');
    
    const header = `[ERROR] ${toolName}${filePath ? ` - ${filePath}${multipleFiles}` : ''}`;
    const errorInfo = code ? `${errorName} (${code})` : errorName;
    
    return `${header}\n${errorInfo}: ${errorMessage}`;
  }

  /**
   * Formats tool output with rich context and shell environment details
   */
  private formatToolOutput(context: ToolOperationContext, output: string): string {
    const { operationType, affectedFiles } = context;
    
    // Get file path for display
    const filePath = affectedFiles && affectedFiles[0] ? affectedFiles[0] : '';
    const multipleFiles = affectedFiles && affectedFiles.length > 1 ? ` (+${affectedFiles.length - 1} files)` : '';
    
    // Simple, clean formatting focused on file names and content
    switch (operationType) {
      case "create":
        if (output.startsWith('[CREATE]') || output.startsWith('[✓]')) return output;
        const createIcon = this.getFileTypeIcon(filePath);
        return `[CREATE] ${createIcon} ${filePath}${multipleFiles}\n${output}`;
        
      case "delete":
        if (output.startsWith('[DELETE]') || output.startsWith('[DEL]')) return output;
        const deleteIcon = this.getFileTypeIcon(filePath);
        return `[DELETE] ${deleteIcon} ${filePath}${multipleFiles}\n${output}`;
        
      case "execute":
        if (output.startsWith('$')) return output;
        const command = this.extractCommand(context.input);
        const commandLine = command ? `$ ${command}` : '$ Command executed';
        return `${commandLine}\n${output}`;
        
      case "edit":
        if (output.startsWith('[EDIT]') || output.startsWith('[EDIT]')) return output;
        const editIcon = this.getFileTypeIcon(filePath);
        const diffOutput = this.createDiffVisualization(output, filePath);
        return `[EDIT] ${editIcon} ${filePath}${multipleFiles}\n${diffOutput}`;
        
      case "search":
        if (output.startsWith('[SEARCH]')) return output;
        return `[SEARCH] Pattern: ${this.extractSearchPattern(context.input) || 'unknown'}\n${output}`;
        
      case "read":
        if (output.startsWith('[READ]') || output.startsWith('[READ]')) return output;
        const lines = output.split('\n').length;
        const chars = output.length;
        const fileIcon = this.getFileTypeIcon(filePath);
        const highlightedOutput = this.addSyntaxHighlighting(output, filePath);
        return `[READ] ${fileIcon} ${filePath} (${lines} lines, ${chars} chars)\n${highlightedOutput}`;
        
      default:
        // Handle additional operation types in default case
        const opType = operationType?.toUpperCase() || 'OPERATION';
        const toolNameLower = context.toolName.toLowerCase();
        
        // Handle specific tools
        if (toolNameLower.includes('write') || context.toolName === 'Write') {
          const writeLines = output.split('\n').length;
          const writeChars = output.length;
          return `[WRITE] ${filePath}${multipleFiles} (${writeLines} lines, ${writeChars} chars)\n${output}`;
        }
        
        if (toolNameLower.includes('webfetch') || toolNameLower.includes('fetch')) {
          const url = this.extractUrl(context.input);
          const fetchLines = output.split('\n').length;
          const fetchChars = output.length;
          return `[WEBFETCH] ${url || 'URL'} (${fetchLines} lines, ${fetchChars} chars fetched)\n${output}`;
        }
        
        if (toolNameLower.includes('grep') || context.toolName === 'Grep') {
          const pattern = this.extractSearchPattern(context.input);
          const results = output.split('\n').filter(line => line.trim().length > 0).length;
          return `[GREP] Pattern: ${pattern || 'unknown'} (${results} results)\n${output}`;
        }
        
        if (toolNameLower.includes('bash') || context.toolName === 'Bash') {
          if (output.startsWith('$')) return output;
          const command = this.extractCommand(context.input);
          const commandLine = command ? `$ ${command}` : '$ Command executed';
          return `${commandLine}\n${output}`;
        }
        
        if (toolNameLower.includes('multiedit') || context.toolName === 'MultiEdit') {
          const editLines = output.split('\n').length;
          const editChars = output.length;
          return `[MULTIEDIT] ${filePath}${multipleFiles} (${editLines} lines, ${editChars} chars)\n${output}`;
        }
        
        return filePath ? `[${opType}] ${filePath}${multipleFiles}\n${output}` : output;
    }
  }

  /**
   * Extracts command from input for display purposes
   */
  private extractCommand(input: unknown): string | null {
    if (!this.isValidInput(input)) return null;
    
    const inputObj = input;
    if (inputObj.command) {
      const cmd = String(inputObj.command);
      // Truncate very long commands for readability
      return cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
    }
    
    return null;
  }

  /**
   * Extracts search pattern from input for display purposes
   */
  private extractSearchPattern(input: unknown): string | null {
    if (!this.isValidInput(input)) return null;
    
    const inputObj = input;
    if (inputObj.pattern) {
      const pattern = String(inputObj.pattern);
      return pattern.length > 50 ? pattern.substring(0, 47) + '...' : pattern;
    }
    if (inputObj.query) {
      const query = String(inputObj.query);
      return query.length > 50 ? query.substring(0, 47) + '...' : query;
    }
    if (inputObj.text) {
      const text = String(inputObj.text);
      return text.length > 50 ? text.substring(0, 47) + '...' : text;
    }
    
    return null;
  }

  /**
   * Extracts URL from input for display purposes
   */
  private extractUrl(input: unknown): string | null {
    if (!this.isValidInput(input)) return null;
    
    const inputObj = input;
    if (inputObj.url) {
      const url = String(inputObj.url);
      return url.length > 80 ? url.substring(0, 77) + '...' : url;
    }
    
    return null;
  }

  /**
   * Gets file type icon based on file extension
   */
  private getFileTypeIcon(filePath: string): string {
    if (!filePath) return '📄';
    
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) return '📄';
    
    const iconMap: Record<string, string> = {
      // JavaScript/TypeScript
      'js': '🟨',
      'jsx': '🟨', 
      'ts': '🔷',
      'tsx': '🔷',
      'mjs': '🟨',
      'cjs': '🟨',
      
      // Web files
      'html': '🌐',
      'htm': '🌐',
      'css': '🎨',
      'scss': '🎨',
      'sass': '🎨',
      'less': '🎨',
      
      // Python
      'py': '🐍',
      'pyw': '🐍',
      'pyc': '🐍',
      
      // Other languages
      'rs': '🦀',
      'go': '🐹',
      'java': '☕',
      'kt': '🟣',
      'swift': '🧡',
      'c': '⚙️',
      'cpp': '⚙️',
      'cc': '⚙️',
      'cxx': '⚙️',
      'h': '⚙️',
      'hpp': '⚙️',
      'cs': '💜',
      'php': '🐘',
      'rb': '💎',
      
      // Data formats
      'json': '📋',
      'yaml': '📋',
      'yml': '📋',
      'xml': '📋',
      'csv': '📊',
      'sql': '🗄️',
      
      // Documentation
      'md': '📝',
      'txt': '📝',
      'rst': '📝',
      'doc': '📝',
      'docx': '📝',
      'pdf': '📕',
      
      // Config files
      'config': '⚙️',
      'conf': '⚙️',
      'ini': '⚙️',
      'env': '⚙️',
      'toml': '⚙️',
      
      // Package files
      'package': '📦',
      'lock': '🔒',
      'cargo': '📦',
      'requirements': '📦',
      'pipfile': '📦',
      
      // Images
      'png': '🖼️',
      'jpg': '🖼️',
      'jpeg': '🖼️',
      'gif': '🖼️',
      'svg': '🖼️',
      'webp': '🖼️',
      
      // Archives
      'zip': '📦',
      'tar': '📦',
      'gz': '📦',
      'rar': '📦',
      '7z': '📦'
    };
    
    return iconMap[ext] || '📄';
  }

  /**
   * Adds basic syntax highlighting to code content
   */
  private addSyntaxHighlighting(content: string, filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) return content;

    // Only highlight small files to avoid performance issues
    if (content.length > 5000) return content;

    const lines = content.split('\n');
    const maxLines = 50; // Limit preview lines
    const previewLines = lines.slice(0, maxLines);
    
    const highlighted = previewLines.map(line => {
      // Simple syntax highlighting patterns
      switch (ext) {
        case 'js':
        case 'jsx':
        case 'ts':
        case 'tsx':
          return this.highlightJavaScript(line);
        case 'py':
          return this.highlightPython(line);
        case 'json':
          return this.highlightJSON(line);
        case 'md':
          return this.highlightMarkdown(line);
        default:
          return line;
      }
    });

    const result = highlighted.join('\n');
    const truncated = lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : '';
    
    return result + truncated;
  }

  /**
   * Simple JavaScript/TypeScript highlighting
   */
  private highlightJavaScript(line: string): string {
    return line
      .replace(/\b(const|let|var|function|class|if|else|for|while|return|import|export|from|interface|type)\b/g, '🔷$1')
      .replace(/\/\/(.*)/g, '💬$1')
      .replace(/"([^"]*)"/g, '🟩"$1"')
      .replace(/'([^']*)'/g, '🟩\'$1\'')
      .replace(/`([^`]*)`/g, '🟩`$1`');
  }

  /**
   * Simple Python highlighting
   */
  private highlightPython(line: string): string {
    return line
      .replace(/\b(def|class|if|elif|else|for|while|return|import|from|try|except)\b/g, '🔷$1')
      .replace(/#(.*)/g, '💬$1')
      .replace(/"([^"]*)"/g, '🟩"$1"')
      .replace(/'([^']*)'/g, '🟩\'$1\'');
  }

  /**
   * Simple JSON highlighting
   */
  private highlightJSON(line: string): string {
    return line
      .replace(/"([^"]*)":/g, '🔷"$1":')
      .replace(/:\s*"([^"]*)"/g, ': 🟩"$1"')
      .replace(/:\s*(true|false|null|\d+)/g, ': 🟡$1');
  }

  /**
   * Simple Markdown highlighting
   */
  private highlightMarkdown(line: string): string {
    return line
      .replace(/^(#{1,6})\s+(.*)/g, '🔷$1 $2')
      .replace(/\*\*(.*?)\*\*/g, '🟡**$1**')
      .replace(/\*(.*?)\*/g, '🟩*$1*')
      .replace(/`([^`]*)`/g, '🟦`$1`');
  }

  /**
   * Creates before/after diff visualization for edit operations
   */
  private createDiffVisualization(output: string, filePath: string): string {
    // Simple diff extraction from common edit tool outputs
    if (!output.includes('→') && !output.includes('-') && !output.includes('+')) {
      return output; // No diff indicators found
    }

    const lines = output.split('\n');
    const diffLines: string[] = [];
    let inDiff = false;

    for (const line of lines) {
      // Detect diff patterns
      if (line.includes('→')) {
        // Line replacement format: "123→ new content" or "old content → new content"
        inDiff = true;
        const parts = line.split('→');
        if (parts.length === 2) {
          diffLines.push(`🟥 - ${parts[0].trim()}`);
          diffLines.push(`🟩 + ${parts[1].trim()}`);
          continue;
        }
      }
      
      if (line.trim().startsWith('-') || line.includes('removed')) {
        inDiff = true;
        diffLines.push(`🟥 ${line}`);
        continue;
      }
      
      if (line.trim().startsWith('+') || line.includes('added')) {
        inDiff = true;
        diffLines.push(`🟩 ${line}`);
        continue;
      }
      
      if (line.includes('@@') || line.includes('diff')) {
        inDiff = true;
        diffLines.push(`🔷 ${line}`);
        continue;
      }

      // Regular line
      if (inDiff && line.trim() === '') {
        diffLines.push(''); // Preserve empty lines in diff
      } else if (inDiff) {
        diffLines.push(`  ${line}`); // Context line
      } else {
        diffLines.push(line); // Non-diff content
      }
    }

    return diffLines.length > lines.length * 0.3 ? diffLines.join('\n') : output;
  }
  
  /**
   * Updates plan progress when tools complete
   */
  private async updatePlanForToolCompletion(sessionId: string, _context: ToolOperationContext): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session.currentPlan) return;
    
    // Find and update relevant plan entries
    let updated = false;
    for (let i = 0; i < session.currentPlan.length; i++) {
      const entry = session.currentPlan[i];
      if (entry.status === "in_progress") {
        entry.status = "completed";
        updated = true;
        
        // Mark next entry as in progress
        if (i + 1 < session.currentPlan.length && session.currentPlan[i + 1].status === "pending") {
          session.currentPlan[i + 1].status = "in_progress";
        }
        break;
      }
    }
    
    if (updated) {
      // Debounce plan updates to avoid spam
      setTimeout(async () => {
        if (session.currentPlan) {
          await this.sendPlanUpdate(sessionId, session.currentPlan);
        }
      }, ClaudeACPAgent.PLAN_UPDATE_DEBOUNCE);
    }
  }
  
  /**
   * Enhanced permission request with full ACP integration
   */
  private async requestEnhancedPermission(
    sessionId: string,
    toolCallId: string, 
    context: ToolOperationContext
  ): Promise<boolean> {
    const session = this.getSession(sessionId);
    const mode = session.permissionMode || this.defaultPermissionMode;
    
    // Quick decisions for simple modes
    if (mode === 'bypassPermissions') return true;
    if (mode === 'acceptEdits' && this.isAutoApprovableOperation(context)) return true;
    
    // Use ACP permission request for complex decisions
    if (this.requiresExplicitPermission(context)) {
      try {
        const permissionRequest: ACPRequestPermissionRequest = {
          sessionId,
          toolCall: {
            toolCallId,
            title: this.generateEnhancedToolTitle(context),
            kind: this.mapToolKind(context.toolName),
            status: "pending",
            rawInput: this.isValidInput(context.input) ? context.input : undefined,
            locations: this.extractToolLocations(context)
          },
          options: this.generatePermissionOptions(context)
        };
        
        const response = await this.client.requestPermission(permissionRequest);
        
        if (response.outcome.outcome === 'cancelled') return false;
        if (response.outcome.outcome === 'selected') {
          const outcome = response.outcome as { outcome: 'selected'; optionId: string };
          const selectedOption = permissionRequest.options.find(opt => opt.optionId === outcome.optionId);
          return selectedOption?.kind === 'allow_once' || selectedOption?.kind === 'allow_always';
        }
        
        return false;
      } catch (error) {
        this.logger.error(`Permission request failed: ${error}`, { sessionId, toolName: context.toolName });
        return mode === 'acceptEdits' && this.isAutoApprovableOperation(context);
      }
    }
    
    return true;
  }
  
  /**
   * Checks if operation is auto-approvable in acceptEdits mode
   */
  private isAutoApprovableOperation(context: ToolOperationContext): boolean {
    const readOnlyOperations = new Set(['read', 'search']);
    return readOnlyOperations.has(context.operationType || 'other');
  }
  
  /**
   * Determines if operation requires explicit permission
   */
  private requiresExplicitPermission(context: ToolOperationContext): boolean {
    const { operationType, affectedFiles } = context;
    
    // Always require permission for destructive operations
    if (operationType === 'delete') return true;
    
    // Require permission for system commands
    if (operationType === 'execute' && this.isValidInput(context.input)) {
      const inputObj = context.input;
      const command = String(inputObj.command || '');
      const dangerousCommands = ['rm', 'sudo', 'chmod', 'chown', 'mv', 'cp', 'dd'];
      if (dangerousCommands.some(cmd => command.includes(cmd))) return true;
    }
    
    // Require permission for operations outside current directory
    if (affectedFiles) {
      const cwd = process.cwd();
      const hasExternalFiles = affectedFiles.some(path => {
        return path.startsWith('/') && !path.startsWith(cwd);
      });
      if (hasExternalFiles) return true;
    }
    
    return false;
  }
  
  /**
   * Generates permission options for tool operations
   */
  private generatePermissionOptions(context: ToolOperationContext): PermissionOption[] {
    const { operationType } = context;
    
    const options: PermissionOption[] = [
      {
        optionId: 'allow_once',
        name: 'Allow this time',
        kind: 'allow_once'
      },
      {
        optionId: 'reject_once', 
        name: 'Deny this time',
        kind: 'reject_once'
      }
    ];
    
    // Add "always" options for non-destructive operations
    if (operationType !== 'delete') {
      options.push({
        optionId: 'allow_always',
        name: 'Always allow this type of operation',
        kind: 'allow_always'
      });
    }
    
    options.push({
      optionId: 'reject_always',
      name: 'Never allow this type of operation',
      kind: 'reject_always'
    });
    
    return options;
  }
  
  /**
   * Generates content annotations for enhanced metadata
   */
  private generateContentAnnotations(
    context: ToolOperationContext, 
    _output: string
  ): ACPAnnotations & { text?: boolean; system?: boolean } {
    const annotations: ACPAnnotations & { text?: boolean; system?: boolean } = {};
    
    // Add audience annotation
    if (context.operationType === "execute" || context.operationType === "delete") {
      annotations.audience = ["user"]; // User should see dangerous operations
    } else {
      annotations.audience = ["assistant"]; // Assistant-focused content
    }
    
    // Add priority based on operation complexity
    switch (context.complexity) {
      case "complex":
        annotations.priority = 3;
        break;
      case "moderate":
        annotations.priority = 2;
        break;
      default:
        annotations.priority = 1;
    }
    
    // Add timestamp for file operations
    if (context.affectedFiles && context.affectedFiles.length > 0) {
      annotations.lastModified = new Date().toISOString();
      annotations.text = true;
    }
    
    // Special annotation for system messages
    if (context.toolName === "system") {
      annotations.system = true;
    }
    
    return annotations;
  }
  
  /**
   * Enhanced content block support for rich media
   */
  private async sendRichContent(
    sessionId: string,
    content: ACPContentBlock,
    updateType: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk"
  ): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: updateType,
        content
      }
    });
  }
  
  /**
   * Creates resource content block for embedded context
   */
  private createResourceContent(uri: string, name: string, description?: string): ACPContentBlock {
    return {
      type: "resource_link",
      uri,
      name,
      description,
      annotations: {
        audience: ["user"],
        priority: 2
      }
    };
  }
  
  /**
   * Enhanced session status with ACP feature metrics
   */
  private getSessionStatus(sessionId: string): {
    active: boolean;
    features: {
      planActive: boolean;
      thoughtStreaming: boolean;
      activeFiles: number;
      complexity: string;
    };
  } {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return {
        active: false,
        features: {
          planActive: false,
          thoughtStreaming: false,
          activeFiles: 0,
          complexity: "none"
        }
      };
    }
    
    const activeContexts = Array.from(session.operationContext?.values() || []);
    const avgComplexity = activeContexts.length > 0 
      ? activeContexts.reduce((acc, ctx) => {
          const complexity = ctx.complexity === "complex" ? 3 : ctx.complexity === "moderate" ? 2 : 1;
          return acc + complexity;
        }, 0) / activeContexts.length
      : 0;
    
    let complexityLevel = "low";
    if (avgComplexity >= 2.5) complexityLevel = "high";
    else if (avgComplexity >= 1.5) complexityLevel = "moderate";
    
    return {
      active: true,
      features: {
        planActive: !!session.currentPlan && session.currentPlan.length > 0,
        thoughtStreaming: !!session.thoughtStreaming,
        activeFiles: session.activeFiles?.size || 0,
        complexity: complexityLevel
      }
    };
  }
  
  /**
   * Enhanced session cleanup with ACP feature cleanup
   */
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController?.abort();
      session.activeFiles?.clear();
      session.operationContext?.clear();
      session.currentPlan = undefined;
    }
    
    this.sessions.delete(sessionId);
    globalResourceManager.removeSession(sessionId);
    
    this.logger.debug(`Cleaned up session: ${sessionId}`);
  }
  
  destroy(): void {
    // Clean up all sessions with enhanced cleanup
    for (const [sessionId] of this.sessions.entries()) {
      this.cleanupSession(sessionId);
    }
    
    this.contextMonitor.destroy();
    this.logger.info('Enhanced ACP Agent destroyed');
  }
}