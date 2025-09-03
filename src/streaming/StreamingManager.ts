import type { Client } from "../protocol.js";
import type { ToolOperationContext } from "../types.js";
import { createLogger, type Logger } from "../logger.js";

// ========== REAL-TIME STREAMING SYSTEM ==========

export interface StreamingOperation {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  startTime: number;
  lastUpdate: number;
  progress: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  estimatedDuration?: number;
  currentStep?: string;
  totalSteps?: number;
  metadata: Record<string, unknown>;
}

export interface StreamingUpdate {
  type: 'progress' | 'status' | 'step' | 'completion';
  operationId: string;
  sessionId: string;
  toolCallId: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Manages real-time streaming operations and progress tracking
 */
export class StreamingManager {
  private static readonly STREAMING_UPDATE_INTERVAL = 500; // ms

  private streamingOperations: Map<string, StreamingOperation> = new Map();
  private streamingClients: Set<Client> = new Set();
  private streamingTimer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger('StreamingManager');
  }

  /**
   * Starts a new streaming operation
   */
  startStreamingOperation(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    estimatedDuration?: number,
    totalSteps?: number
  ): string {
    const operationId = `op-${sessionId}-${toolCallId}-${Date.now()}`;
    const operation: StreamingOperation = {
      id: operationId,
      sessionId,
      toolCallId,
      toolName,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      progress: 0,
      status: 'pending',
      estimatedDuration,
      totalSteps,
      currentStep: 'initializing',
      metadata: {}
    };

    this.streamingOperations.set(operationId, operation);
    this.logger.debug(`Started streaming operation: ${operationId} (${toolName})`);

    // Start the streaming update timer if not already running
    if (!this.streamingTimer) {
      this.startStreamingTimer();
    }

    return operationId;
  }

  /**
   * Updates streaming operation progress
   */
  updateStreamingProgress(
    operationId: string,
    progress: number,
    currentStep?: string,
    metadata?: Record<string, unknown>
  ): void {
    const operation = this.streamingOperations.get(operationId);
    if (!operation) return;

    operation.progress = Math.max(0, Math.min(100, progress));
    operation.lastUpdate = Date.now();
    if (currentStep) operation.currentStep = currentStep;
    if (metadata) Object.assign(operation.metadata, metadata);

    this.logger.debug(`Updated streaming operation ${operationId}: ${progress}% - ${currentStep || 'processing'}`);
  }

  /**
   * Completes a streaming operation
   */
  completeStreamingOperation(operationId: string, success: boolean = true): void {
    const operation = this.streamingOperations.get(operationId);
    if (!operation) return;

    operation.status = success ? 'completed' : 'failed';
    operation.progress = success ? 100 : 0;
    operation.lastUpdate = Date.now();

    this.logger.debug(`Completed streaming operation: ${operationId} (${success ? 'success' : 'failed'})`);

    // Send final update and cleanup
    setTimeout(() => {
      this.streamingOperations.delete(operationId);
    }, 5000); // Keep for 5 seconds after completion
  }

  /**
   * Estimates operation duration based on tool type and context
   */
  estimateOperationDuration(operationContext: ToolOperationContext): number {
    const { toolName, complexity, affectedFiles } = operationContext;
    let baseDuration = 2000; // 2 seconds base

    // Tool-specific duration estimates
    switch (toolName?.toLowerCase()) {
      case 'grep':
      case 'search':
        baseDuration = 5000; // 5 seconds for search operations
        break;
      case 'webfetch':
        baseDuration = 10000; // 10 seconds for web requests
        break;
      case 'multiedit':
        baseDuration = affectedFiles ? affectedFiles.length * 3000 : 8000;
        break;
      case 'bash':
      case 'run':
        baseDuration = 15000; // 15 seconds for shell operations
        break;
      case 'notebook':
        baseDuration = 8000; // 8 seconds for notebook operations
        break;
      default:
        baseDuration = complexity === 'complex' ? 5000 : 2000;
    }

    // Scale by file count for file operations
    if (affectedFiles && affectedFiles.length > 1) {
      baseDuration *= Math.min(affectedFiles.length, 5); // Cap at 5x
    }

    return baseDuration;
  }

  /**
   * Estimates operation steps based on tool type and context
   */
  estimateOperationSteps(operationContext: ToolOperationContext): number {
    const { toolName, complexity, affectedFiles } = operationContext;

    switch (toolName?.toLowerCase()) {
      case 'multiedit':
        return affectedFiles ? Math.max(affectedFiles.length, 3) : 3;
      case 'notebook':
        return 4; // analyze, read, edit, save
      case 'grep':
        return 2; // search, process results
      case 'webfetch':
        return 3; // request, download, process
      case 'bash':
        return 2; // execute, capture output
      default:
        return complexity === 'complex' ? 3 : 1;
    }
  }

  /**
   * Registers a client for streaming updates
   */
  registerStreamingClient(client: Client): void {
    this.streamingClients.add(client);
    this.logger.debug(`Registered streaming client: ${this.streamingClients.size} total clients`);
  }

  /**
   * Unregisters a client from streaming updates
   */
  unregisterStreamingClient(client: Client): void {
    this.streamingClients.delete(client);
    this.logger.debug(`Unregistered streaming client: ${this.streamingClients.size} remaining clients`);
  }

  /**
   * Gets all active streaming operations
   */
  getActiveOperations(): StreamingOperation[] {
    return Array.from(this.streamingOperations.values());
  }

  /**
   * Gets operation by ID
   */
  getOperation(operationId: string): StreamingOperation | undefined {
    return this.streamingOperations.get(operationId);
  }

  /**
   * Cleans up all streaming resources
   */
  cleanup(): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
    this.streamingOperations.clear();
    this.streamingClients.clear();
    this.logger.info('Streaming manager cleaned up');
  }

  /**
   * Starts the streaming update timer
   */
  private startStreamingTimer(): void {
    this.streamingTimer = setInterval(() => {
      this.processStreamingUpdates();
    }, StreamingManager.STREAMING_UPDATE_INTERVAL);
  }

  /**
   * Processes and sends streaming updates to clients
   */
  private async processStreamingUpdates(): Promise<void> {
    if (this.streamingOperations.size === 0) {
      if (this.streamingTimer) {
        clearInterval(this.streamingTimer);
        this.streamingTimer = null;
      }
      return;
    }

    const now = Date.now();
    const updates: StreamingUpdate[] = [];

    for (const operation of this.streamingOperations.values()) {
      // Skip completed operations older than 30 seconds
      if (operation.status === 'completed' && (now - operation.lastUpdate) > 30000) {
        continue;
      }

      // Calculate estimated progress based on time for long-running operations
      if (operation.status === 'running' && operation.estimatedDuration) {
        const elapsed = now - operation.startTime;
        const estimatedProgress = Math.min(90, (elapsed / operation.estimatedDuration) * 100);
        if (estimatedProgress > operation.progress) {
          operation.progress = estimatedProgress;
        }
      }

      // Create progress update
      updates.push({
        type: 'progress',
        operationId: operation.id,
        sessionId: operation.sessionId,
        toolCallId: operation.toolCallId,
        data: {
          progress: operation.progress,
          status: operation.status,
          currentStep: operation.currentStep,
          elapsedTime: now - operation.startTime,
          metadata: operation.metadata
        },
        timestamp: now
      });
    }

    // Send updates to all streaming clients
    if (updates.length > 0) {
      await this.broadcastStreamingUpdates(updates);
    }
  }

  /**
   * Broadcasts streaming updates to all registered clients
   */
  private async broadcastStreamingUpdates(updates: StreamingUpdate[]): Promise<void> {
    for (const client of this.streamingClients) {
      try {
        for (const update of updates) {
          await client.sessionUpdate({
            sessionId: update.sessionId,
            update: {
              sessionUpdate: "streaming_update",
              operationId: update.operationId,
              toolCallId: update.toolCallId,
              type: update.type,
              data: update.data,
              timestamp: update.timestamp
            }
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to send streaming update to client: ${error}`);
      }
    }
  }
}
