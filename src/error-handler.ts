// Centralized error handling system inspired by Gemini CLI
import { createLogger, type Logger } from './logger.js';

export interface ErrorContext {
  sessionId?: string;
  operation?: string;
  toolName?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export class ACPError extends Error {
  public readonly code: string;
  public readonly context: ErrorContext;
  public readonly timestamp: Date;
  public readonly isRecoverable: boolean;

  constructor(
    message: string,
    code: string = 'UNKNOWN_ERROR',
    context: ErrorContext = {},
    isRecoverable: boolean = false
  ) {
    super(message);
    this.name = 'ACPError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date();
    this.isRecoverable = isRecoverable;

    // Ensure the error stack is preserved
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ACPError);
    }
  }
}

export class ValidationError extends ACPError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 'VALIDATION_ERROR', context, false);
    this.name = 'ValidationError';
  }
}

export class SessionError extends ACPError {
  constructor(message: string, sessionId: string, context: ErrorContext = {}) {
    super(message, 'SESSION_ERROR', { ...context, sessionId }, true);
    this.name = 'SessionError';
  }
}

export class ResourceError extends ACPError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 'RESOURCE_ERROR', context, true);
    this.name = 'ResourceError';
  }
}

export class ProtocolError extends ACPError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, 'PROTOCOL_ERROR', context, false);
    this.name = 'ProtocolError';
  }
}

export class ACPErrorHandler {
  private readonly logger: Logger;
  private errorCount = 0;
  private readonly errorHistory: Array<{ error: ACPError; timestamp: Date }> = [];
  private readonly MAX_ERROR_HISTORY = 100;

  constructor() {
    this.logger = createLogger('ErrorHandler');
    
    // Increase max listeners to prevent warnings in test environments
    const currentMaxListeners = process.getMaxListeners();
    if (currentMaxListeners < 25) {
      process.setMaxListeners(25);
    }
    
    this.setupUnhandledRejectionHandler();
    this.setupUncaughtExceptionHandler();
  }

  /**
   * Handle errors in a centralized way with proper logging and user-friendly messages
   */
  public handleError(error: Error | ACPError, context: ErrorContext = {}): ACPError {
    this.errorCount++;

    // Convert regular errors to ACPError
    const acpError = error instanceof ACPError ? error : this.wrapError(error, context);

    // Log the error with full context
    this.logError(acpError);

    // Add to error history
    this.errorHistory.push({ error: acpError, timestamp: new Date() });
    if (this.errorHistory.length > this.MAX_ERROR_HISTORY) {
      this.errorHistory.shift();
    }

    return acpError;
  }

  /**
   * Handle validation errors with user-friendly messages
   */
  public handleValidationError(fieldName: string, value: unknown, requirements: string, context: ErrorContext = {}): ValidationError {
    const message = `Invalid ${fieldName}: ${requirements}. Received: ${JSON.stringify(value)}`;
    const error = new ValidationError(message, context);
    return this.handleError(error, context) as ValidationError;
  }

  /**
   * Handle session-related errors
   */
  public handleSessionError(message: string, sessionId: string, context: ErrorContext = {}): SessionError {
    const error = new SessionError(message, sessionId, context);
    return this.handleError(error, context) as SessionError;
  }

  /**
   * Handle resource exhaustion errors
   */
  public handleResourceError(message: string, context: ErrorContext = {}): ResourceError {
    const error = new ResourceError(message, context);
    return this.handleError(error, context) as ResourceError;
  }

  /**
   * Handle protocol-related errors
   */
  public handleProtocolError(message: string, context: ErrorContext = {}): ProtocolError {
    const error = new ProtocolError(message, context);
    return this.handleError(error, context) as ProtocolError;
  }

  /**
   * Get error statistics for monitoring
   */
  public getErrorStats(): { total: number; recent: number; byCode: Record<string, number> } {
    const now = Date.now();
    const recentThreshold = 5 * 60 * 1000; // 5 minutes
    
    const recent = this.errorHistory.filter(
      ({ timestamp }) => now - timestamp.getTime() < recentThreshold
    ).length;

    const byCode: Record<string, number> = {};
    this.errorHistory.forEach(({ error }) => {
      byCode[error.code] = (byCode[error.code] || 0) + 1;
    });

    return {
      total: this.errorCount,
      recent,
      byCode
    };
  }

  /**
   * Clear error history (useful for testing)
   */
  public clearHistory(): void {
    this.errorHistory.length = 0;
    this.errorCount = 0;
  }

  private wrapError(error: Error, context: ErrorContext): ACPError {
    // Detect specific error types and wrap appropriately
    if (error.message.includes('validation') || error.message.includes('invalid')) {
      return new ValidationError(error.message, context);
    }
    
    if (error.message.includes('session')) {
      return new SessionError(error.message, context.sessionId || 'unknown', context);
    }
    
    if (error.message.includes('resource') || error.message.includes('limit') || error.message.includes('exhausted')) {
      return new ResourceError(error.message, context);
    }

    // Generic wrapper
    return new ACPError(error.message, 'WRAPPED_ERROR', context, false);
  }

  private logError(error: ACPError): void {
    const logContext = {
      code: error.code,
      recoverable: error.isRecoverable,
      context: error.context,
      stack: error.stack
    };

    if (error.isRecoverable) {
      this.logger.warn(`Recoverable error: ${error.message}`, logContext);
    } else {
      this.logger.error(`Critical error: ${error.message}`, logContext);
    }
  }

  private setupUnhandledRejectionHandler(): void {
    process.on('unhandledRejection', (reason, promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      const acpError = this.handleError(error, { operation: 'unhandled-rejection' });
      
      this.logger.error('Unhandled promise rejection detected', {
        error: acpError.message,
        code: acpError.code,
        promise: promise.toString()
      });
    });
  }

  private setupUncaughtExceptionHandler(): void {
    process.on('uncaughtException', (error) => {
      const acpError = this.handleError(error, { operation: 'uncaught-exception' });
      
      this.logger.error('Uncaught exception detected', {
        error: acpError.message,
        code: acpError.code,
        stack: acpError.stack
      });

      // For uncaught exceptions, we should exit gracefully
      this.logger.error('Process will exit due to uncaught exception');
      process.exit(1);
    });
  }
}

// Global error handler instance
let globalErrorHandler: ACPErrorHandler | null = null;

export function getGlobalErrorHandler(): ACPErrorHandler {
  if (!globalErrorHandler) {
    globalErrorHandler = new ACPErrorHandler();
  }
  return globalErrorHandler;
}

export function resetGlobalErrorHandler(): void {
  globalErrorHandler = null;
}

// Convenience functions for common error patterns
export function handleValidationError(fieldName: string, value: unknown, requirements: string, context: ErrorContext = {}): never {
  const error = getGlobalErrorHandler().handleValidationError(fieldName, value, requirements, context);
  throw error;
}

export function handleSessionError(message: string, sessionId: string, context: ErrorContext = {}): never {
  const error = getGlobalErrorHandler().handleSessionError(message, sessionId, context);
  throw error;
}

export function handleResourceError(message: string, context: ErrorContext = {}): never {
  const error = getGlobalErrorHandler().handleResourceError(message, context);
  throw error;
}

export function handleProtocolError(message: string, context: ErrorContext = {}): never {
  const error = getGlobalErrorHandler().handleProtocolError(message, context);
  throw error;
}

