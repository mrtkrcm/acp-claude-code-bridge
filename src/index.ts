import { AgentSideConnection } from "@zed-industries/agent-client-protocol";
import { Writable, Readable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { ClaudeACPAgent } from "./agent.js";
import { DiagnosticSystem } from "./diagnostics.js";
import { createLogger } from "./logger.js";

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

  // Initialize centralized logging
  const logger = createLogger('ACP-Bridge');
  logger.writeStartupMessage();

  logger.info("Starting Claude Code ACP Bridge...");

  // Run pre-flight checks
  await performPreflightChecks(logger);

  try {
    // Prevent any accidental stdout writes that could corrupt the protocol
    console.log = (...args) => {
      console.error("[WARNING] console.log intercepted:", ...args);
    };

    logger.debug("Creating ACP connection via stdio...");

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
    let agent: ClaudeACPAgent | null = null;
    new AgentSideConnection(
      (client) => {
        logger.debug("Creating ClaudeACPAgent with client");
        agent = new ClaudeACPAgent(client);
        return agent;
      },
      outputStream, // WritableStream for sending data to client (stdout)
      inputStream, // ReadableStream for receiving data from client (stdin)
    );

    // Log connection creation success
    logger.debug("ACP Connection created successfully");

    logger.info("Claude Code ACP Bridge is running");

    // Keep the process alive
    process.stdin.resume();

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      logger.info("Received SIGINT, shutting down...");
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }
      logger.destroy();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      logger.info("Received SIGTERM, shutting down...");
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }
      logger.destroy();
      process.exit(0);
    });

    // Handle uncaught errors
    process.on("uncaughtException", (error) => {
      logger.error(`[FATAL] Uncaught exception: ${error.message}`, { stack: error.stack });
      logger.destroy();
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error(`[FATAL] Unhandled rejection`, { promise: String(promise), reason: String(reason) });
      logger.destroy();
      process.exit(1);
    });
  } catch (error) {
    logger.error(`[FATAL] Error starting ACP bridge: ${error}`);
    logger.destroy();
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

async function performPreflightChecks(logger: ReturnType<typeof createLogger>): Promise<void> {
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
      logger.debug(`Found ${warnings.length} non-critical warnings. Run --diagnose for details.`);
    }
    
    logger.debug(`Compatibility score: ${report.score}/100`);
    
  } catch (error) {
    logger.warn(`Preflight check failed: ${error}`);
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
