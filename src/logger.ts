import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  context?: Record<string, unknown>;
  args?: string[];
}

export class Logger {
  private readonly component: string;
  private readonly debugMode: boolean;
  private fileLogger: NodeJS.WritableStream | null = null;
  private logBuffer: LogEntry[] = [];
  private flushTimer?: NodeJS.Timeout;
  private readonly BUFFER_SIZE = 50;
  private readonly FLUSH_INTERVAL = 5000; // 5 seconds

  constructor(component: string, debugMode = false) {
    this.component = component;
    this.debugMode = debugMode;
    this.initializeFileLogging();
  }

  private initializeFileLogging(): void {
    const logFile = process.env.ACP_LOG_FILE;
    if (!logFile) return;

    try {
      const logPath = resolve(logFile);
      this.fileLogger = createWriteStream(logPath, { flags: 'a' });
      this.fileLogger.on('error', (error) => {
        console.error(`[${this.component}] Log file error: ${error.message}`);
        this.fileLogger = null;
      });
    } catch (error) {
      console.error(`[${this.component}] Failed to create log file: ${error}`);
    }
  }

  log(message: string, level: LogLevel = 'DEBUG', contextOrArgs?: Record<string, unknown> | unknown, ...args: unknown[]): void {
    // Handle flexible parameter types for backwards compatibility
    let context: Record<string, unknown> | undefined;
    let allArgs = args;
    
    if (typeof contextOrArgs === 'object' && contextOrArgs !== null && !Array.isArray(contextOrArgs)) {
      try {
        context = contextOrArgs as Record<string, unknown>;
      } catch {
        allArgs = [contextOrArgs, ...args];
      }
    } else if (contextOrArgs !== undefined) {
      allArgs = [contextOrArgs, ...args];
    }
    
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      context,
      args: allArgs.length > 0 ? allArgs.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ) : undefined
    };

    const formattedMessage = `[${entry.timestamp}] [${level}] [${this.component}] ${message}`;
    const argsStr = entry.args?.length ? ` ${entry.args.join(' ')}` : '';

    // Console output based on level and debug setting
    if (this.debugMode || level !== 'DEBUG') {
      const consoleMethod = this.getConsoleMethod(level);
      consoleMethod(formattedMessage + argsStr);
    }

    // File logging with buffering
    if (this.fileLogger) {
      this.logBuffer.push(entry);
      
      // Immediate flush for errors or if buffer is full
      if (level === 'ERROR' || this.logBuffer.length >= this.BUFFER_SIZE) {
        this.flushLogBuffer();
      } else if (!this.flushTimer) {
        // Schedule flush
        this.flushTimer = setTimeout(() => this.flushLogBuffer(), this.FLUSH_INTERVAL);
      }
    }
  }

  private getConsoleMethod(level: LogLevel): typeof console.log {
    switch (level) {
      case 'ERROR': return console.error;
      case 'WARN': return console.warn;
      default: return console.log;
    }
  }

  debug(message: string, contextOrArgs?: Record<string, unknown> | unknown, ...args: unknown[]): void {
    this.log(message, 'DEBUG', contextOrArgs, ...args);
  }

  info(message: string, contextOrArgs?: Record<string, unknown> | unknown, ...args: unknown[]): void {
    this.log(message, 'INFO', contextOrArgs, ...args);
  }

  warn(message: string, contextOrArgs?: Record<string, unknown> | unknown, ...args: unknown[]): void {
    this.log(message, 'WARN', contextOrArgs, ...args);
  }

  error(message: string, contextOrArgs?: Record<string, unknown> | unknown, ...args: unknown[]): void {
    this.log(message, 'ERROR', contextOrArgs, ...args);
  }

  writeStartupMessage(): void {
    if (this.fileLogger) {
      this.fileLogger.write(`\n=== ${this.component} Started at ${new Date().toISOString()} ===\n`);
    }
  }

  writeShutdownMessage(): void {
    if (this.fileLogger) {
      this.fileLogger.write(`=== ${this.component} Stopped at ${new Date().toISOString()} ===\n`);
      this.fileLogger.end();
    }
  }

  private flushLogBuffer(): void {
    if (this.logBuffer.length === 0) return;
    
    if (this.fileLogger) {
      const entries = this.logBuffer.splice(0); // Clear buffer
      const logText = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      this.fileLogger.write(logText);
    }
    
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  destroy(): void {
    // Flush any remaining logs
    this.flushLogBuffer();
    this.writeShutdownMessage();
  }
}

// Factory function for consistent logger creation
export function createLogger(component: string): Logger {
  return new Logger(component, process.env.ACP_DEBUG === 'true');
}