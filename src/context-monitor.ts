export interface ContextWarning { level: 'warning' | 'critical'; message: string; usage: number; }
export interface SessionStats { usage: number; estimatedTokens: number; messages: number; turnCount: number; lastActivity: number; lastUpdate: Date; }

export class ContextMonitor {
  private sessions = new Map<string, SessionStats>();
  private readonly CONTEXT_LIMIT = 200000;
  private readonly WARNING_THRESHOLD = 0.8;
  private readonly CRITICAL_THRESHOLD = 0.95;
  
  constructor(_debugMode?: boolean) {}
  
  addMessage(sessionId: string, content: string, role?: 'user' | 'assistant'): ContextWarning | null {
    const tokens = Math.ceil(content.length / 4);
    const stats = this.sessions.get(sessionId) || { usage: 0, estimatedTokens: 0, messages: 0, turnCount: 0, lastActivity: Date.now(), lastUpdate: new Date() };
    
    stats.estimatedTokens += tokens;
    stats.usage = Math.min(stats.estimatedTokens / this.CONTEXT_LIMIT, 1);
    stats.messages++;
    if (role === 'user') stats.turnCount++;
    stats.lastActivity = Date.now();
    stats.lastUpdate = new Date();
    
    this.sessions.set(sessionId, stats);
    
    if (stats.usage >= this.CRITICAL_THRESHOLD) return { level: 'critical', message: `Context usage critical (${(stats.usage * 100).toFixed(1)}%)`, usage: stats.usage };
    if (stats.usage >= this.WARNING_THRESHOLD) return { level: 'warning', message: `High context usage (${(stats.usage * 100).toFixed(1)}%)`, usage: stats.usage };
    return null;
  }
  
  getStats(sessionId: string): SessionStats | null { return this.sessions.get(sessionId) || null; }
  getAllStats(): Map<string, SessionStats> { return this.sessions; }
  clearSession(sessionId: string): void { this.sessions.delete(sessionId); }
  
  getSessionSummary(sessionId: string): string {
    const stats = this.sessions.get(sessionId);
    if (!stats) return `Session ${sessionId}: No data`;
    
    const usageKB = Math.round(stats.estimatedTokens / 1000);
    const limitKB = Math.round(this.CONTEXT_LIMIT / 1000);
    const percent = Math.round(stats.usage * 100);
    const status = stats.usage >= this.CRITICAL_THRESHOLD ? '[!]' : stats.usage >= this.WARNING_THRESHOLD ? '[WARNING]' : '[✓]';
    const usageLabel = stats.usage >= this.CRITICAL_THRESHOLD ? 'CRITICAL' : stats.usage >= this.WARNING_THRESHOLD ? 'HIGH' : 'OK';
    const turnsLabel = stats.turnCount === 1 ? '1 turn' : `${stats.turnCount} turns`;
    
    return `${status} Context: ${usageKB}K/${limitKB}K (${percent}%) | ${turnsLabel} | Status: ${usageLabel}`;
  }
  
  cleanupInactiveSessions(maxInactiveMs: number = 3600000): number {
    const now = Date.now();
    let removed = 0;
    for (const [sessionId, stats] of this.sessions.entries()) {
      if (now - stats.lastActivity > maxInactiveMs) { this.sessions.delete(sessionId); removed++; }
    }
    return removed;
  }
  
  resetSession(sessionId: string): void {
    const stats = this.sessions.get(sessionId);
    if (stats) {
      stats.usage = 0; stats.estimatedTokens = 0; stats.messages = 0; stats.turnCount = 0;
      stats.lastActivity = Date.now(); stats.lastUpdate = new Date();
    }
  }
  
  getMemoryStats(): { activeSessions: number; totalMessages: number; totalTokens: number; averageTokensPerSession: number } {
    let totalMessages = 0; let totalTokens = 0;
    for (const stats of this.sessions.values()) { totalMessages += stats.messages; totalTokens += stats.estimatedTokens; }
    return { activeSessions: this.sessions.size, totalMessages, totalTokens, averageTokensPerSession: this.sessions.size ? totalTokens / this.sessions.size : 0 };
  }
  
  cleanupOldSessions(maxAgeMs: number): number { return this.cleanupInactiveSessions(maxAgeMs); }
}