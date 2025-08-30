import { AgentSideConnection } from "@zed-industries/agent-client-protocol";
import { ClaudeACPAgent } from "./agent.js";
import { DiagnosticSystem } from "./diagnostics.js";
import { Writable, Readable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

export async function main() {
  // Check for diagnostic mode first
  if (process.argv.includes('--diagnose')) {
    await runDiagnostics();
    return;
  }

  // Validate environment early
  await validateEnvironment();

  // Add process debugging for Zed startup issues
  process.on('disconnect', () => {
    console.error('[ACP-Claude] Parent process disconnected');
  });

  process.on('SIGPIPE', () => {
    console.error('[ACP-Claude] SIGPIPE received - parent closed pipe');
    process.exit(1);
  });

  // Only log to stderr in debug mode
  const DEBUG = process.env.ACP_DEBUG === "true";
  const LOG_FILE = process.env.ACP_LOG_FILE;

  // Set up file logging if specified
  let fileLogger: NodeJS.WritableStream | null = null;
  if (LOG_FILE) {
    try {
      const logPath = resolve(LOG_FILE);
      fileLogger = createWriteStream(logPath, { flags: 'a' }); // append mode
      fileLogger.write(`\n=== ACP Bridge Started at ${new Date().toISOString()} ===\n`);
    } catch (error) {
      console.error(`[ACP-Claude] Failed to create log file ${LOG_FILE}: ${error}`);
    }
  }

  const log = (message: string, level: 'INFO' | 'DEBUG' | 'ERROR' | 'WARN' = 'INFO') => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] [ACP-Claude] ${message}`;
    
    // Always log to stderr in debug mode
    if (DEBUG) {
      console.error(logMessage);
    }
    
    // Log to file if configured
    if (fileLogger) {
      fileLogger.write(logMessage + '\n');
    }
  };

  log("Starting Claude Code ACP Bridge...");

  // Run pre-flight checks
  await performPreflightChecks(log);

  try {
    // Prevent any accidental stdout writes that could corrupt the protocol
    console.log = (...args) => {
      console.error("[WARNING] console.log intercepted:", ...args);
    };

    log("Creating ACP connection via stdio...");

    // Convert Node.js streams to Web Streams
    // IMPORTANT: stdout is for sending to client, stdin is for receiving from client
    const outputStream = Writable.toWeb(
      process.stdout,
    ) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(
      process.stdin,
    ) as ReadableStream<Uint8Array>;

    // We're implementing an Agent, so we use AgentSideConnection
    // First parameter is output (to client), second is input (from client)
    new AgentSideConnection(
      (client) => {
        log("Creating ClaudeACPAgent with client", 'DEBUG');
        return new ClaudeACPAgent(client);
      },
      outputStream, // WritableStream for sending data to client (stdout)
      inputStream, // ReadableStream for receiving data from client (stdin)
    );

    // Log connection creation success
    log("ACP Connection created successfully", 'DEBUG');

    log("Claude Code ACP Bridge is running");

    // Keep the process alive
    process.stdin.resume();

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      log("Received SIGINT, shutting down...", 'INFO');
      if (fileLogger) {
        fileLogger.write(`=== ACP Bridge Stopped at ${new Date().toISOString()} ===\n`);
        fileLogger.end();
      }
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      log("Received SIGTERM, shutting down...", 'INFO');
      if (fileLogger) {
        fileLogger.write(`=== ACP Bridge Stopped at ${new Date().toISOString()} ===\n`);
        fileLogger.end();
      }
      process.exit(0);
    });

    // Handle uncaught errors
    process.on("uncaughtException", (error) => {
      const errorMsg = `[FATAL] Uncaught exception: ${error.message}\nStack: ${error.stack}`;
      console.error(errorMsg);
      if (fileLogger) {
        fileLogger.write(`${errorMsg}\n`);
        fileLogger.end();
      }
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      const errorMsg = `[FATAL] Unhandled rejection at: ${promise}, reason: ${reason}`;
      console.error(errorMsg);
      if (fileLogger) {
        fileLogger.write(`${errorMsg}\n`);
        fileLogger.end();
      }
      process.exit(1);
    });
  } catch (error) {
    const errorMsg = `[FATAL] Error starting ACP bridge: ${error}`;
    console.error(errorMsg);
    if (fileLogger) {
      fileLogger.write(`${errorMsg}\n`);
      fileLogger.end();
    }
    process.exit(1);
  }
}

async function runDiagnostics(): Promise<void> {
  console.error("🔍 Running ACP-Claude-Code Diagnostics...\n");
  
  try {
    const report = await DiagnosticSystem.generateReport();
    const formattedReport = DiagnosticSystem.formatReport(report);
    
    console.error(formattedReport);
    
    // Exit with appropriate code
    process.exit(report.compatible ? 0 : 1);
  } catch (error) {
    console.error("❌ Failed to generate diagnostic report:", error);
    process.exit(1);
  }
}

async function performPreflightChecks(log: (message: string) => void): Promise<void> {
  try {
    const report = await DiagnosticSystem.generateReport();
    
    // Log critical issues that could prevent operation
    const criticalIssues = report.issues.filter(issue => 
      issue.level === 'error' && 
      ['EXECUTABLE_NOT_FOUND', 'NOT_AUTHENTICATED', 'NODE_VERSION'].includes(issue.code || '')
    );
    
    if (criticalIssues.length > 0) {
      console.error("🚨 Critical issues detected that may prevent operation:");
      criticalIssues.forEach(issue => {
        console.error(`   ❌ ${issue.message}`);
        if (issue.solution) {
          console.error(`      → Solution: ${issue.solution}`);
        }
      });
      console.error("\nRun 'acp-claude-code --diagnose' for detailed analysis.");
      console.error("Attempting to continue anyway...\n");
    }
    
    // Log warnings for non-optimal conditions
    const warnings = report.issues.filter(issue => issue.level === 'warning');
    if (warnings.length > 0 && process.env.ACP_DEBUG === "true") {
      log(`Found ${warnings.length} non-critical warnings. Run --diagnose for details.`);
    }
    
    log(`Compatibility score: ${report.score}/100`);
    
  } catch (error) {
    log(`Preflight check failed: ${error}`);
    // Continue anyway - don't block on diagnostic failures
  }
}

async function validateEnvironment(): Promise<void> {
  const errors: string[] = [];
  
  // Check Node.js version
  const nodeVersion = parseInt(process.version.slice(1), 10);
  if (nodeVersion < 18) {
    errors.push(`Node.js ${process.version} is too old. Requires Node.js 18+`);
  }

  // Validate environment variables
  const maxTurns = process.env.ACP_MAX_TURNS;
  if (maxTurns && (!/^\d+$/.test(maxTurns) || parseInt(maxTurns, 10) < 0)) {
    errors.push(`Invalid ACP_MAX_TURNS: "${maxTurns}" must be a non-negative integer`);
  }

  const permissionMode = process.env.ACP_PERMISSION_MODE;
  if (permissionMode && !["default", "acceptEdits", "bypassPermissions", "plan"].includes(permissionMode)) {
    errors.push(`Invalid ACP_PERMISSION_MODE: "${permissionMode}"`);
  }

  if (errors.length > 0) {
    console.error("❌ Environment validation failed:");
    errors.forEach(error => console.error(`   • ${error}`));
    process.exit(1);
  }
}

export { ClaudeACPAgent };
