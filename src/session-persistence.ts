import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { EnhancedContentBlock } from './types.js';

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
  enhancedContent?: EnhancedContentHistory[];
}

interface EnhancedContentHistory {
  id: string;
  timestamp: string;
  toolName?: string;
  contentType: 'image' | 'audio' | 'resource' | 'diff';
  content: EnhancedContentBlock;
  metadata?: Record<string, unknown>;
}

interface SessionPersistenceConfig {
  baseDir?: string;
  maxSessions?: number;
  maxAge?: number; // in milliseconds
  compressionEnabled?: boolean;
  maxEnhancedContent?: number; // Maximum enhanced content items per session
}

export class SessionPersistenceManager {
  private readonly baseDir: string;
  private readonly maxSessions: number;
  private readonly maxAge: number;
  private readonly compressionEnabled: boolean;
  private readonly maxEnhancedContent: number;
  
  constructor(config: SessionPersistenceConfig = {}) {
    this.baseDir = config.baseDir || resolve(homedir(), '.acp-claude-code', 'sessions');
    this.maxSessions = config.maxSessions || 100;
    this.maxAge = config.maxAge || 7 * 24 * 60 * 60 * 1000; // 7 days
    this.compressionEnabled = config.compressionEnabled || false;
    this.maxEnhancedContent = config.maxEnhancedContent || 50;
    
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

  /**
   * Store enhanced content for a session
   */
  async storeEnhancedContent(
    sessionId: string,
    content: EnhancedContentBlock,
    toolName?: string
  ): Promise<void> {
    try {
      // Load existing session data
      let sessionData = await this.loadSession(sessionId);
      if (!sessionData) {
        sessionData = {
          sessionId,
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
          enhancedContent: [],
        };
      }

      // Ensure enhancedContent array exists
      if (!sessionData.enhancedContent) {
        sessionData.enhancedContent = [];
      }

      // Create new content entry
      const contentEntry: EnhancedContentHistory = {
        id: this.generateContentId(),
        timestamp: new Date().toISOString(),
        toolName,
        contentType: content.type,
        content,
        metadata: {
          size: this.calculateContentSize(content),
        },
      };

      // Add to session
      sessionData.enhancedContent.unshift(contentEntry);

      // Trim to max content limit
      if (sessionData.enhancedContent.length > this.maxEnhancedContent) {
        sessionData.enhancedContent = sessionData.enhancedContent.slice(0, this.maxEnhancedContent);
      }

      // Save updated session
      await this.saveSession(sessionData);
    } catch (error) {
      throw new Error(
        `Failed to store enhanced content for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Retrieve enhanced content for a session
   */
  async getEnhancedContent(
    sessionId: string,
    contentType?: 'image' | 'audio' | 'resource' | 'diff',
    limit?: number
  ): Promise<EnhancedContentHistory[]> {
    try {
      const sessionData = await this.loadSession(sessionId);
      if (!sessionData?.enhancedContent) {
        return [];
      }

      let content = sessionData.enhancedContent;

      // Filter by content type if specified
      if (contentType) {
        content = content.filter(item => item.contentType === contentType);
      }

      // Apply limit if specified
      if (limit && limit > 0) {
        content = content.slice(0, limit);
      }

      return content;
    } catch (error) {
      throw new Error(
        `Failed to get enhanced content for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Delete specific enhanced content entry
   */
  async deleteEnhancedContent(sessionId: string, contentId: string): Promise<boolean> {
    try {
      const sessionData = await this.loadSession(sessionId);
      if (!sessionData?.enhancedContent) {
        return false;
      }

      const initialLength = sessionData.enhancedContent.length;
      sessionData.enhancedContent = sessionData.enhancedContent.filter(
        item => item.id !== contentId
      );

      const wasDeleted = sessionData.enhancedContent.length < initialLength;
      if (wasDeleted) {
        await this.saveSession(sessionData);
      }

      return wasDeleted;
    } catch (error) {
      throw new Error(
        `Failed to delete enhanced content ${contentId} for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Get enhanced content statistics for a session
   */
  async getEnhancedContentStats(sessionId: string): Promise<{
    totalItems: number;
    contentTypes: Record<string, number>;
    totalSize: number;
    oldestContent?: string;
    newestContent?: string;
  }> {
    try {
      const content = await this.getEnhancedContent(sessionId);
      const contentTypes: Record<string, number> = {};
      let totalSize = 0;

      content.forEach(item => {
        contentTypes[item.contentType] = (contentTypes[item.contentType] || 0) + 1;
        totalSize += this.calculateContentSize(item.content);
      });

      return {
        totalItems: content.length,
        contentTypes,
        totalSize,
        oldestContent: content.length > 0 ? content[content.length - 1].timestamp : undefined,
        newestContent: content.length > 0 ? content[0].timestamp : undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to get enhanced content stats for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Generate unique content ID
   */
  private generateContentId(): string {
    return `content_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Calculate approximate size of content in bytes
   */
  private calculateContentSize(content: EnhancedContentBlock): number {
    try {
      const jsonString = JSON.stringify(content);
      return new Blob([jsonString]).size;
    } catch {
      // Fallback to rough character count estimation
      return JSON.stringify(content).length * 2; // Rough UTF-8 estimation
    }
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