import * as fs from 'fs';
import * as path from 'path';
import type { AgentSession } from "../agent.js";
import * as schema from "../schema.js";
import { createLogger, type Logger } from "../logger.js";

interface SessionData {
  sessionId: string;
  createdAt: string;
  turnCount: number;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  contextTokens: number;
  metadata: {
    userAgent: string;
    version: string;
    savedAt: string;
  };
}

/**
 * Manages session persistence and lifecycle
 */
export class SessionManager {
  private sessions: Map<string, AgentSession> = new Map();
  private readonly sessionDir: string;
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger('SessionManager');
    this.sessionDir = path.join(process.cwd(), '.acp-sessions');
    this.ensureSessionDirectory();
  }

  /**
   * Creates a new session with persistence
   */
  createSession(
    sessionId: string,
    options: {
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
      mcpServers?: schema.McpServer[];
    } = {}
  ): AgentSession {
    const now = Date.now();
    const session: AgentSession = {
      pendingPrompt: null,
      abortController: null,
      permissionMode: options.permissionMode || 'default',
      activeFiles: new Set(),
      thoughtStreaming: true,
      createdAt: now,
      lastActivityAt: now,
      turnCount: 0,
      operationContext: new Map(),
      mcpServers: options.mcpServers,
    };

    this.sessions.set(sessionId, session);
    this.saveSessionState(sessionId);

    this.logger.info(`Created session: ${sessionId}`);
    return session;
  }

  /**
   * Loads a session from disk or creates a new one
   */
  loadSession(sessionId: string, mcpServers?: schema.McpServer[]): AgentSession | null {
    this.logger.info(`Loading session: ${sessionId}`);

    // First check if session exists in memory
    if (this.sessions.has(sessionId)) {
      this.logger.debug(`Session ${sessionId} already exists in memory`);
      return this.sessions.get(sessionId)!;
    }

    // Try to load session from disk
    if (this.loadSessionState(sessionId)) {
      const session = this.sessions.get(sessionId)!;

      // Update MCP servers if provided
      if (mcpServers && mcpServers.length > 0) {
        session.mcpServers = mcpServers;
        this.logger.info(`MCP servers configured: ${mcpServers.map(s => s.name).join(', ')}`);
      }

      this.logger.info(`Session ${sessionId} loaded from disk`);
      return session;
    }

    // Log MCP server configuration for transparency
    if (mcpServers && mcpServers.length > 0) {
      this.logger.info(`MCP servers configured: ${mcpServers.map(s => s.name).join(', ')}`);
    }

    this.logger.debug(`Session ${sessionId} not found - creating new session`);
    return null; // Signal to create new session
  }

  /**
   * Gets an existing session
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Updates session activity
   */
  updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Increments session turn count
   */
  incrementTurnCount(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.turnCount = (session.turnCount || 0) + 1;
    }
  }

  /**
   * Saves session state to disk
   */
  saveSessionState(sessionId: string): void {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.logger.warn(`Cannot save session state: session ${sessionId} not found`);
        return;
      }

      const sessionData: SessionData = {
        sessionId,
        createdAt: new Date(session.createdAt).toISOString(),
        turnCount: session.turnCount || 0,
        permissionMode: session.permissionMode || 'default',
        contextTokens: this.getCurrentContextTokens(sessionId),
        metadata: {
          userAgent: 'acp-claude-code-bridge',
          version: '0.21.0',
          savedAt: new Date().toISOString()
        }
      };

      const filePath = this.getSessionFilePath(sessionId);
      fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');

      this.logger.debug(`Session state saved: ${sessionId}`);

    } catch (error) {
      this.logger.error(`Failed to save session state for ${sessionId}:`, error);
    }
  }

  /**
   * Loads session state from disk
   */
  private loadSessionState(sessionId: string): boolean {
    try {
      const filePath = this.getSessionFilePath(sessionId);

      if (!fs.existsSync(filePath)) {
        return false;
      }

      const sessionData: SessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      // Create session from saved data
      const session: AgentSession = {
        pendingPrompt: null,
        abortController: null,
        permissionMode: sessionData.permissionMode || 'default',
        activeFiles: new Set(),
        thoughtStreaming: true,
        createdAt: new Date(sessionData.createdAt).getTime(),
        lastActivityAt: Date.now(),
        turnCount: sessionData.turnCount || 0,
        operationContext: new Map(),
      };

      this.sessions.set(sessionId, session);

      this.logger.debug(`Session state loaded: ${sessionId} (${sessionData.contextTokens || 0} tokens)`);
      return true;

    } catch (error) {
      this.logger.warn(`Failed to load session state for ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Gets the current context tokens (simplified implementation)
   */
  private getCurrentContextTokens(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    // Estimate based on session activity
    const turnCount = session.turnCount || 0;
    return Math.min(turnCount * 1000, 200000); // Conservative estimate
  }

  /**
   * Gets the file path for a session
   */
  private getSessionFilePath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }

  /**
   * Ensures the session directory exists
   */
  private ensureSessionDirectory(): void {
    try {
      if (!fs.existsSync(this.sessionDir)) {
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }
    } catch (error) {
      this.logger.error('Failed to create session directory:', error);
    }
  }

  /**
   * Cleans up old sessions
   */
  cleanupOldSessions(): void {
    try {
      const files = fs.readdirSync(this.sessionDir);
      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

      let cleaned = 0;
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.sessionDir, file);
          const stats = fs.statSync(filePath);

          if (now - stats.mtime.getTime() > maxAge) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        }
      }

      if (cleaned > 0) {
        this.logger.info(`Cleaned up ${cleaned} old session files`);
      }
    } catch (error) {
      this.logger.warn('Failed to cleanup old sessions:', error);
    }
  }

  /**
   * Lists all available sessions
   */
  listSessions(): Array<{ sessionId: string; createdAt: number; lastActivity: number; turnCount: number }> {
    return Array.from(this.sessions.values()).map(session => ({
      sessionId: Array.from(this.sessions.entries()).find(([_, s]) => s === session)![0],
      createdAt: session.createdAt,
      lastActivity: session.lastActivityAt,
      turnCount: session.turnCount || 0
    }));
  }

  /**
   * Removes a session
   */
  removeSession(sessionId: string): boolean {
    try {
      // Remove from memory
      const removed = this.sessions.delete(sessionId);

      // Remove from disk
      const filePath = this.getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      if (removed) {
        this.logger.info(`Session removed: ${sessionId}`);
      }

      return removed;
    } catch (error) {
      this.logger.error(`Failed to remove session ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Gets session statistics
   */
  getSessionStats(): {
    totalSessions: number;
    activeSessions: number;
    totalTurns: number;
    averageSessionAge: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const now = Date.now();

    const totalSessions = sessions.length;
    const activeSessions = sessions.filter(s => (now - s.lastActivityAt) < 3600000).length; // Active in last hour
    const totalTurns = sessions.reduce((sum, s) => sum + (s.turnCount || 0), 0);
    const averageSessionAge = totalSessions > 0
      ? sessions.reduce((sum, s) => sum + (now - s.createdAt), 0) / totalSessions
      : 0;

    return {
      totalSessions,
      activeSessions,
      totalTurns,
      averageSessionAge
    };
  }

  /**
   * Cleans up all session resources
   */
  cleanup(): void {
    this.sessions.clear();
    this.logger.info('Session manager cleaned up');
  }
}
