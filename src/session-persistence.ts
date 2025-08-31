import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

interface PersistedSessionData {
  sessionId: string;
  claudeSessionId?: string;
  permissionMode?: string;
  contextStats?: {
    estimatedTokens: number;
    messages: number;
    turnCount: number;
    lastUpdate: string;
  };
  createdAt: string;
  lastAccessed: string;
  metadata?: Record<string, unknown>;
}

interface SessionPersistenceConfig {
  baseDir?: string;
  maxSessions?: number;
  maxAge?: number; // in milliseconds
  compressionEnabled?: boolean;
}

export class SessionPersistenceManager {
  private readonly baseDir: string;
  private readonly maxSessions: number;
  private readonly maxAge: number;
  private readonly compressionEnabled: boolean;
  
  constructor(config: SessionPersistenceConfig = {}) {
    this.baseDir = config.baseDir || resolve(homedir(), '.acp-claude-code', 'sessions');
    this.maxSessions = config.maxSessions || 100;
    this.maxAge = config.maxAge || 7 * 24 * 60 * 60 * 1000; // 7 days
    this.compressionEnabled = config.compressionEnabled || false;
    
    this.ensureDirectoryExists();
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await access(this.baseDir);
    } catch {
      await mkdir(this.baseDir, { recursive: true });
    }
  }

  /**
   * Save session data to persistent storage
   */
  async saveSession(sessionData: Partial<PersistedSessionData> & { sessionId: string }): Promise<void> {
    const sessionPath = this.getSessionPath(sessionData.sessionId);
    
    const data: PersistedSessionData = {
      ...sessionData,
      lastAccessed: new Date().toISOString(),
      createdAt: sessionData.createdAt || new Date().toISOString()
    };

    try {
      // Ensure directory exists
      await mkdir(dirname(sessionPath), { recursive: true });
      
      // Write session data
      const serialized = JSON.stringify(data, null, 2);
      await writeFile(sessionPath, serialized, 'utf8');
      
    } catch (error) {
      throw new Error(`Failed to save session ${sessionData.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load session data from persistent storage
   */
  async loadSession(sessionId: string): Promise<PersistedSessionData | null> {
    const sessionPath = this.getSessionPath(sessionId);
    
    try {
      if (!existsSync(sessionPath)) {
        return null;
      }
      
      const data = await readFile(sessionPath, 'utf8');
      const sessionData: PersistedSessionData = JSON.parse(data);
      
      // Update last accessed time
      sessionData.lastAccessed = new Date().toISOString();
      await this.saveSession(sessionData);
      
      return sessionData;
      
    } catch (error) {
      throw new Error(`Failed to load session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * List all available sessions
   */
  async listSessions(): Promise<PersistedSessionData[]> {
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(this.baseDir);
      const sessions: PersistedSessionData[] = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '');
          const session = await this.loadSession(sessionId);
          if (session) {
            sessions.push(session);
          }
        }
      }
      
      // Sort by last accessed (most recent first)
      return sessions.sort((a, b) => 
        new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()
      );
      
    } catch (error) {
      throw new Error(`Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a session from persistent storage
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(sessionId);
    
    try {
      if (!existsSync(sessionPath)) {
        return false;
      }
      
      const { unlink } = await import('node:fs/promises');
      await unlink(sessionPath);
      return true;
      
    } catch (error) {
      throw new Error(`Failed to delete session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clean up old and excessive sessions
   */
  async cleanup(): Promise<{ deletedCount: number; freedSpace: number }> {
    const sessions = await this.listSessions();
    const now = Date.now();
    let deletedCount = 0;
    let freedSpace = 0;
    
    // Remove sessions older than maxAge
    for (const session of sessions) {
      const lastAccessed = new Date(session.lastAccessed).getTime();
      if (now - lastAccessed > this.maxAge) {
        const sessionPath = this.getSessionPath(session.sessionId);
        try {
          const { stat } = await import('node:fs/promises');
          const stats = await stat(sessionPath);
          freedSpace += stats.size;
          
          await this.deleteSession(session.sessionId);
          deletedCount++;
        } catch {
          // Ignore errors for individual file cleanup
        }
      }
    }
    
    // If we still have too many sessions, remove the oldest ones
    const remainingSessions = sessions.filter(s => {
      const lastAccessed = new Date(s.lastAccessed).getTime();
      return now - lastAccessed <= this.maxAge;
    });
    
    if (remainingSessions.length > this.maxSessions) {
      const toDelete = remainingSessions.slice(this.maxSessions);
      for (const session of toDelete) {
        try {
          const sessionPath = this.getSessionPath(session.sessionId);
          const { stat } = await import('node:fs/promises');
          const stats = await stat(sessionPath);
          freedSpace += stats.size;
          
          await this.deleteSession(session.sessionId);
          deletedCount++;
        } catch {
          // Ignore errors for individual file cleanup
        }
      }
    }
    
    return { deletedCount, freedSpace };
  }

  /**
   * Export session data for backup or migration
   */
  async exportSessions(): Promise<PersistedSessionData[]> {
    return await this.listSessions();
  }

  /**
   * Import session data from backup
   */
  async importSessions(sessions: PersistedSessionData[]): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];
    
    for (const session of sessions) {
      try {
        await this.saveSession(session);
        imported++;
      } catch (error) {
        errors.push(`Failed to import session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return { imported, errors };
  }

  /**
   * Get storage usage statistics
   */
  async getStorageStats(): Promise<{
    totalSessions: number;
    totalSize: number;
    oldestSession?: string;
    newestSession?: string;
    averageSize: number;
  }> {
    const sessions = await this.listSessions();
    let totalSize = 0;
    
    for (const session of sessions) {
      try {
        const sessionPath = this.getSessionPath(session.sessionId);
        const { stat } = await import('node:fs/promises');
        const stats = await stat(sessionPath);
        totalSize += stats.size;
      } catch {
        // Ignore errors for individual files
      }
    }
    
    const oldestSession = sessions.length > 0 ? sessions[sessions.length - 1].sessionId : undefined;
    const newestSession = sessions.length > 0 ? sessions[0].sessionId : undefined;
    
    return {
      totalSessions: sessions.length,
      totalSize,
      oldestSession,
      newestSession,
      averageSize: sessions.length > 0 ? Math.round(totalSize / sessions.length) : 0
    };
  }

  private getSessionPath(sessionId: string): string {
    return resolve(this.baseDir, `${sessionId}.json`);
  }
}

// Default singleton instance
let defaultManager: SessionPersistenceManager | null = null;

export function getDefaultPersistenceManager(): SessionPersistenceManager {
  if (!defaultManager) {
    defaultManager = new SessionPersistenceManager();
  }
  return defaultManager;
}