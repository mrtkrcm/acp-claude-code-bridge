import { writeFile, readFile, mkdir, readdir, unlink, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

interface PersistedSessionData {
  sessionId: string; claudeSessionId?: string; permissionMode?: string;
  createdAt: string; lastAccessed: string; metadata?: Record<string, unknown>;
}

interface SessionPersistenceConfig { baseDir?: string; maxSessions?: number; maxAge?: number; }

export class SessionPersistenceManager {
  private readonly baseDir: string;
  private readonly maxSessions: number;
  private readonly maxAge: number;
  
  private cleanupRegistered = false;

  constructor(config: SessionPersistenceConfig = {}) {
    this.baseDir = config.baseDir || process.env.ACP_SESSIONS_DIR || resolve(homedir(), '.acp-claude-code', 'sessions');
    this.maxSessions = config.maxSessions || 100;
    this.maxAge = config.maxAge || 7 * 24 * 60 * 60 * 1000;
    this.cleanupTempFiles().catch(() => {});
    this.registerCleanupHandlers();
  }
  
  private async ensureDirectoryExists(): Promise<void> {
    if (!existsSync(this.baseDir)) { 
      await mkdir(this.baseDir, { recursive: true }); 
    }
  }
  
  async saveSession(sessionData: PersistedSessionData): Promise<void> {
    await this.ensureDirectoryExists();
    const sessionPath = resolve(this.baseDir, `${sessionData.sessionId}.json`);
    const tempPath = `${sessionPath}.tmp.${Date.now()}.${process.pid}`;
    
    try {
      await writeFile(tempPath, JSON.stringify(sessionData, null, 2));
      await rename(tempPath, sessionPath);
    } catch (error) {
      try { await unlink(tempPath); } catch { /* ignore cleanup errors */ }
      throw error;
    }
  }
  
  async loadSession(sessionId: string): Promise<PersistedSessionData | null> {
    try {
      const sessionPath = resolve(this.baseDir, `${sessionId}.json`);
      const content = await readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content) as PersistedSessionData;
      session.lastAccessed = new Date().toISOString();
      await this.saveSession(session);
      return session;
    } catch { return null; }
  }
  
  async cleanupInactiveSessions(maxAge?: number): Promise<number> {
    const ageThreshold = maxAge || this.maxAge;
    let removed = 0;
    try {
      const files = await readdir(this.baseDir);
      const sessionFiles = files.filter(f => f.endsWith('.json') && !f.includes('.tmp.'));
      const now = Date.now();
      
      for (const file of sessionFiles) {
        try {
          const filePath = resolve(this.baseDir, file);
          const stats = await stat(filePath);
          if (now - stats.mtime.getTime() > ageThreshold) { 
            await unlink(filePath); 
            removed++; 
          }
        } catch { /* ignore file errors */ }
      }
    } catch { /* ignore directory errors */ }
    
    return removed;
  }

  async cleanup(): Promise<{ removed: number; errors: number }> {
    let removed = 0, errors = 0;
    try {
      const files = await readdir(this.baseDir);
      const sessionFiles = files.filter(f => f.endsWith('.json') && !f.includes('.tmp.'));
      const now = Date.now();
      
      for (const file of sessionFiles) {
        try {
          const filePath = resolve(this.baseDir, file);
          const stats = await stat(filePath);
          if (now - stats.mtime.getTime() > this.maxAge) { await unlink(filePath); removed++; }
        } catch { errors++; }
      }
      
      if (sessionFiles.length - removed > this.maxSessions) {
        const excess = sessionFiles.length - removed - this.maxSessions;
        const sortedFiles = await Promise.all(sessionFiles.map(async f => {
          try { return { file: f, mtime: (await stat(resolve(this.baseDir, f))).mtime.getTime() }; }
          catch { return { file: f, mtime: 0 }; }
        }));
        sortedFiles.sort((a, b) => a.mtime - b.mtime);
        
        for (let i = 0; i < excess; i++) {
          try { await unlink(resolve(this.baseDir, sortedFiles[i].file)); removed++; } catch { errors++; }
        }
      }
    } catch { errors++; }
    
    return { removed, errors };
  }
  
  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await readdir(this.baseDir);
      const tempFiles = files.filter(file => file.includes('.tmp.'));
      let cleanedCount = 0;
      
      for (const tempFile of tempFiles) {
        try {
          const tempPath = resolve(this.baseDir, tempFile);
          const stats = await stat(tempPath);
          if (Date.now() - stats.mtime.getTime() > 60 * 60 * 1000) { await unlink(tempPath); cleanedCount++; }
        } catch { /* ignore file stat/unlink errors */ }
      }
      
      if (cleanedCount > 0) console.log(`Cleaned up ${cleanedCount} stale temp files`);
    } catch { /* ignore directory read errors */ }
  }
  
  private registerCleanupHandlers(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    
    const cleanup = () => { this.cleanupTempFiles().catch(() => {}); };
    process.once('exit', cleanup); process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup);
    process.once('uncaughtException', cleanup); process.once('unhandledRejection', cleanup);
  }
}

let defaultManager: SessionPersistenceManager | null = null;
export function getDefaultPersistenceManager(): SessionPersistenceManager {
  if (!defaultManager) {
    const config = process.env.ACP_SESSIONS_DIR ? { baseDir: process.env.ACP_SESSIONS_DIR } : {};
    defaultManager = new SessionPersistenceManager(config);
  }
  return defaultManager;
}

export function resetDefaultPersistenceManager(): void {
  defaultManager = null;
}