export interface ContextStats {
  estimatedTokens: number;
  maxTokens: number;
  usage: number; // 0-1 percentage
  messages: number;
  turnCount: number;
  lastUpdate: Date;
}

export interface ContextWarning {
  level: 'info' | 'warning' | 'critical';
  message: string;
  usage: number;
  recommendation?: string;
}

export class ContextMonitor {
  private sessions: Map<string, ContextStats> = new Map();
  private readonly MAX_TOKENS = 200000; // Claude's context window
  private readonly WARNING_THRESHOLD = 0.8; // 80%
  private readonly CRITICAL_THRESHOLD = 0.95; // 95%

  constructor(private debug: boolean = false) {}

  private log(message: string): void {
    if (this.debug) {
      console.error(`[ContextMonitor] ${message}`);
    }
  }

  /**
   * Rough token estimation based on character count
   * Generally ~4 characters per token for English text
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    
    // More accurate estimation accounting for:
    // - Word boundaries (tokens often align with words)  
    // - Punctuation and special characters
    // - Code vs natural language differences
    
    const chars = text.length;
    const words = text.split(/\s+/).length;
    const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
    
    // Base estimation: ~4 chars per token
    let tokenEstimate = chars / 4;
    
    // Adjust for word boundaries - tokens often align with words
    tokenEstimate = Math.max(tokenEstimate, words * 0.75);
    
    // Code tends to have more tokens per character
    if (codeBlocks > 0) {
      tokenEstimate *= 1.2;
    }
    
    return Math.ceil(tokenEstimate);
  }

  trackMessage(sessionId: string, content: string, type: 'user' | 'assistant' = 'user'): ContextWarning | null {
    const tokens = this.estimateTokens(content);
    const stats = this.sessions.get(sessionId) || {
      estimatedTokens: 0,
      maxTokens: this.MAX_TOKENS,
      usage: 0,
      messages: 0,
      turnCount: 0,
      lastUpdate: new Date(),
    };

    // Update stats
    stats.estimatedTokens += tokens;
    stats.messages += 1;
    stats.lastUpdate = new Date();
    
    if (type === 'user') {
      stats.turnCount += 1;
    }
    
    stats.usage = stats.estimatedTokens / stats.maxTokens;
    
    this.sessions.set(sessionId, stats);
    
    this.log(
      `Session ${sessionId}: +${tokens} tokens (${type}), total: ${stats.estimatedTokens}/${stats.maxTokens} (${(stats.usage * 100).toFixed(1)}%)`
    );

    // Check for warnings
    return this.checkWarnings(sessionId, stats);
  }

  private checkWarnings(sessionId: string, stats: ContextStats): ContextWarning | null {
    if (stats.usage >= this.CRITICAL_THRESHOLD) {
      return {
        level: 'critical',
        message: `Context window at ${(stats.usage * 100).toFixed(1)}% - approaching limit!`,
        usage: stats.usage,
        recommendation: 'Consider starting a new session or using /clear to reset context.'
      };
    } else if (stats.usage >= this.WARNING_THRESHOLD) {
      return {
        level: 'warning',
        message: `Context window at ${(stats.usage * 100).toFixed(1)}% - performance may degrade`,
        usage: stats.usage,
        recommendation: 'Monitor context usage. Use /clear if responses become slow.'
      };
    } else if (stats.usage >= 0.5) {
      return {
        level: 'info',
        message: `Context window at ${(stats.usage * 100).toFixed(1)}%`,
        usage: stats.usage,
      };
    }
    
    return null;
  }

  getStats(sessionId: string): ContextStats | null {
    return this.sessions.get(sessionId) || null;
  }

  getAllStats(): Map<string, ContextStats> {
    return new Map(this.sessions);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.log(`Cleared context stats for session ${sessionId}`);
  }

  resetSession(sessionId: string): void {
    const stats = this.sessions.get(sessionId);
    if (stats) {
      stats.estimatedTokens = 0;
      stats.usage = 0;
      stats.messages = 0;
      stats.turnCount = 0;
      stats.lastUpdate = new Date();
      this.sessions.set(sessionId, stats);
      this.log(`Reset context stats for session ${sessionId}`);
    }
  }

  getSessionSummary(sessionId: string): string {
    const stats = this.getStats(sessionId);
    if (!stats) {
      return `Session ${sessionId}: No data available`;
    }

    const usagePercent = (stats.usage * 100).toFixed(1);
    const tokensK = (stats.estimatedTokens / 1000).toFixed(1);
    const maxK = (stats.maxTokens / 1000).toFixed(0);
    
    let status = '✅';
    if (stats.usage >= this.CRITICAL_THRESHOLD) status = '🚨';
    else if (stats.usage >= this.WARNING_THRESHOLD) status = '⚠️';
    else if (stats.usage >= 0.5) status = '📊';
    
    return `${status} Context: ${tokensK}K/${maxK}K tokens (${usagePercent}%), ${stats.turnCount} turns`;
  }

  // Cleanup old sessions to prevent memory leaks
  cleanupOldSessions(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sessionId, stats] of this.sessions.entries()) {
      if (now - stats.lastUpdate.getTime() > maxAge) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.log(`Cleaned up ${cleaned} old sessions`);
    }
    
    return cleaned;
  }
}