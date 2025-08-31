export interface ContextStats {
  estimatedTokens: number;
  maxTokens: number;
  usage: number;
  messages: number;
  turnCount: number;
  lastUpdate: Date;
}

export interface MemoryStats {
  activeSessions: number;
  totalMessages: number;
  totalTokens: number;
  averageTokensPerSession: number;
}

export interface ContextWarning {
  level: 'info' | 'warning' | 'critical';
  message: string;
  usage: number;
  recommendation?: string;
}

export class ContextMonitor {
  private sessions: Map<string, ContextStats> = new Map();
  private readonly MAX_TOKENS = 200000;
  private readonly WARNING_THRESHOLD = 0.8;
  private readonly CRITICAL_THRESHOLD = 0.95;

  constructor(_debugMode = false) {
    // Debug mode parameter maintained for compatibility but not used
    // Logging is handled by individual components now
  }

  private estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }
  
  addTokens(sessionId: string, tokenCount: number, turnCount?: number): ContextWarning | null {
    const stats = this.sessions.get(sessionId) || {
      estimatedTokens: 0,
      maxTokens: this.MAX_TOKENS,
      usage: 0,
      messages: 0,
      turnCount: 0,
      lastUpdate: new Date()
    };

    stats.estimatedTokens += tokenCount;
    stats.messages += 1;
    if (turnCount) stats.turnCount = turnCount;
    stats.usage = stats.estimatedTokens / stats.maxTokens;
    stats.lastUpdate = new Date();
    
    this.sessions.set(sessionId, stats);

    if (stats.usage >= this.CRITICAL_THRESHOLD) {
      return {
        level: 'critical',
        message: 'Context window nearly full',
        usage: stats.usage,
        recommendation: 'Consider starting new session'
      };
    } else if (stats.usage >= this.WARNING_THRESHOLD) {
      return {
        level: 'warning', 
        message: 'High context usage',
        usage: stats.usage
      };
    }

    return null;
  }

  addMessage(sessionId: string, content: string, role?: 'user' | 'assistant'): ContextWarning | null {
    const tokenCount = this.estimateTokens(content);
    const isUserMessage = role === 'user';
    
    const stats = this.sessions.get(sessionId) || {
      estimatedTokens: 0,
      maxTokens: this.MAX_TOKENS,
      usage: 0,
      messages: 0,
      turnCount: 0,
      lastUpdate: new Date()
    };

    stats.estimatedTokens += tokenCount;
    stats.messages += 1;
    if (isUserMessage) stats.turnCount += 1;
    stats.usage = stats.estimatedTokens / stats.maxTokens;
    stats.lastUpdate = new Date();
    
    this.sessions.set(sessionId, stats);

    if (stats.usage >= this.CRITICAL_THRESHOLD) {
      return {
        level: 'critical',
        message: 'Context window nearly full',
        usage: stats.usage,
        recommendation: 'Consider starting new session'
      };
    } else if (stats.usage >= this.WARNING_THRESHOLD) {
      return {
        level: 'warning', 
        message: 'High context usage',
        usage: stats.usage
      };
    }

    return null;
  }

  getStats(sessionId: string): ContextStats | null {
    return this.sessions.get(sessionId) || null;
  }

  resetSession(sessionId: string): void {
    const stats = this.sessions.get(sessionId);
    if (stats) {
      stats.estimatedTokens = 0;
      stats.messages = 0;
      stats.turnCount = 0;
      stats.usage = 0;
      stats.lastUpdate = new Date();
      this.sessions.set(sessionId, stats);
    }
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSessionSummary(sessionId: string): string {
    const stats = this.sessions.get(sessionId);
    if (!stats) return 'Session not found';

    const tokensK = (stats.estimatedTokens / 1000).toFixed(1);
    const maxTokensK = (stats.maxTokens / 1000).toFixed(0);
    const usagePercent = Math.round(stats.usage * 100);
    
    let status = '[✓]';
    let usageLabel = 'OK';
    
    if (stats.usage >= this.CRITICAL_THRESHOLD) {
      status = '[!]';
      usageLabel = 'CRITICAL';
    } else if (stats.usage >= this.WARNING_THRESHOLD) {
      status = '[⚠]';
      usageLabel = 'HIGH';
    }
    
    const turnsLabel = stats.turnCount === 1 ? '1 turn' : `${stats.turnCount} turns`;
    
    return `${status} Context: ${tokensK}K/${maxTokensK}K (${usagePercent}%) | ${turnsLabel} | Status: ${usageLabel}`;
  }

  getMemoryStats(): MemoryStats {
    const activeSessions = this.sessions.size;
    let totalMessages = 0;
    let totalTokens = 0;
    
    for (const stats of this.sessions.values()) {
      totalMessages += stats.messages;
      totalTokens += stats.estimatedTokens;
    }
    
    const averageTokensPerSession = activeSessions > 0 ? Math.round(totalTokens / activeSessions) : 0;
    
    return {
      activeSessions,
      totalMessages,
      totalTokens,
      averageTokensPerSession
    };
  }

  cleanupOldSessions(maxAgeMs?: number): number {
    const now = Date.now();
    const CLEANUP_AGE = maxAgeMs || 4 * 60 * 60 * 1000; // 4 hours default
    
    let cleaned = 0;
    for (const [sessionId, stats] of this.sessions.entries()) {
      if (now - stats.lastUpdate.getTime() > CLEANUP_AGE) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }
    
    return cleaned;
  }

  getAllStats(): Map<string, ContextStats> {
    return new Map(this.sessions);
  }
}