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

  constructor() {
    this.logger = createLogger('ErrorHandler');
    this.setupUnhandledRejectionHandler();
    this.setupUncaughtExceptionHandler();
  }

  /**
   * Handle errors with logging
   */
  public handleError(error: Error | ACPError, context: ErrorContext = {}): ACPError {
    this.errorCount++;
    const acpError = error instanceof ACPError ? error : this.wrapError(error, context);
    this.logError(acpError);
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
   * Get total error count
   */
  public getErrorCount(): number {
    return this.errorCount;
  }

  /**
   * Reset error count
   */
  public reset(): void {
    this.errorCount = 0;
  }

  private wrapError(error: Error, context: ErrorContext): ACPError {
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

// Global error handler instance for backward compatibility
let globalErrorHandler: ACPErrorHandler | null = null;

export function getGlobalErrorHandler(): ACPErrorHandler {
  if (!globalErrorHandler) {
    globalErrorHandler = new ACPErrorHandler();
  }
  return globalErrorHandler;
}

export function resetGlobalErrorHandler(): void {
  globalErrorHandler?.reset();
  globalErrorHandler = null;
}

// Factory function for dependency injection
export function createErrorHandler(): ACPErrorHandler {
  return new ACPErrorHandler();
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

