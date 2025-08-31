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
    
    // Enhanced token estimation with better accuracy
    const chars = text.length;
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    const lines = text.split('\n').length;
    
    // Detect different content types for better estimation
    const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
    const jsonBlocks = (text.match(/\{[\s\S]*?\}/g) || []).length;
    const markdownHeaders = (text.match(/^#+\s/gm) || []).length;
    const urls = (text.match(/https?:\/\/[^\s]+/g) || []).length;
    
    // Base estimation: ~4 chars per token for natural language
    let tokenEstimate = chars / 4;
    
    // Adjust for word boundaries - tokens often align with words
    tokenEstimate = Math.max(tokenEstimate, words * 0.75);
    
    // Content-specific adjustments
    if (codeBlocks > 0) {
      tokenEstimate *= 1.3; // Code is more token-dense
    }
    
    if (jsonBlocks > 3) {
      tokenEstimate *= 1.2; // JSON/structured data
    }
    
    if (urls > 0) {
      tokenEstimate += urls * 2; // URLs are typically multiple tokens
    }
    
    if (markdownHeaders > 0) {
      tokenEstimate += markdownHeaders * 1.5; // Headers add formatting tokens
    }
    
    // Line-based adjustment for very long or short lines
    if (lines > 10) {
      const avgLineLength = chars / lines;
      if (avgLineLength > 100) {
        tokenEstimate *= 1.1; // Long lines tend to be more token-dense
      }
    }
    
    // Add small buffer for safety
    tokenEstimate *= 1.05;
    
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
    
    // Enhanced status indicators
    let status = '\u2705'; // Default: good
    let indicator = '';
    
    if (stats.usage >= this.CRITICAL_THRESHOLD) {
      status = '\ud83d\udea8';
      indicator = ' CRITICAL';
    } else if (stats.usage >= this.WARNING_THRESHOLD) {
      status = '\u26a0\ufe0f';
      indicator = ' HIGH';
    } else if (stats.usage >= 0.5) {
      status = '\ud83d\udcc8';
      indicator = ' MODERATE';
    }
    
    // Include time since last activity for idle sessions
    const timeSinceUpdate = Date.now() - stats.lastUpdate.getTime();
    const minutesAgo = Math.floor(timeSinceUpdate / (1000 * 60));
    const timeInfo = minutesAgo > 5 ? ` (${minutesAgo}m ago)` : '';
    
    return `${status} ${tokensK}K/${maxK}K (${usagePercent}%)${indicator}, ${stats.turnCount} turns${timeInfo}`;
  }

  // Enhanced cleanup with better memory management and reporting
  cleanupOldSessions(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    let totalMemoryFreed = 0;
    
    for (const [sessionId, stats] of this.sessions.entries()) {
      if (now - stats.lastUpdate.getTime() > maxAge) {
        totalMemoryFreed += stats.estimatedTokens;
        this.sessions.delete(sessionId);
        cleaned++;
        this.log(`Cleaned session ${sessionId}: ${stats.estimatedTokens} tokens, ${stats.messages} messages`);
      }
    }
    
    if (cleaned > 0) {
      this.log(`\u267e\ufe0f Cleaned up ${cleaned} old sessions, freed ~${totalMemoryFreed} tokens of memory`);
    }
    
    return cleaned;
  }

  // Get memory usage statistics
  getMemoryStats(): { 
    activeSessions: number;
    totalTokens: number;
    totalMessages: number;
    averageTokensPerSession: number;
    oldestSession?: string;
  } {
    const sessions = Array.from(this.sessions.entries());
    const totalTokens = sessions.reduce((sum, [, stats]) => sum + stats.estimatedTokens, 0);
    const totalMessages = sessions.reduce((sum, [, stats]) => sum + stats.messages, 0);
    
    let oldestSession: string | undefined;
    let oldestTime = Date.now();
    
    for (const [sessionId, stats] of sessions) {
      if (stats.lastUpdate.getTime() < oldestTime) {
        oldestTime = stats.lastUpdate.getTime();
        oldestSession = sessionId;
      }
    }
    
    return {
      activeSessions: sessions.length,
      totalTokens,
      totalMessages,
      averageTokensPerSession: sessions.length > 0 ? Math.round(totalTokens / sessions.length) : 0,
      oldestSession
    };
  }
}