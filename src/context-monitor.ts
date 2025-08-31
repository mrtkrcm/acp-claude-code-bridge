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
  private analyticsData: Map<string, {
    tokenEstimationAccuracy: number[];
    performanceMetrics: Array<{
      timestamp: number;
      operation: string;
      duration: number;
      tokens: number;
    }>;
  }> = new Map();

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
  private estimateTokens(text: string, sessionId?: string): number {
    if (!text) return 0;
    
    const startTime = Date.now();
    
    // Enhanced token estimation with machine learning insights
    const analysis = this.analyzeTextStructure(text);
    let tokenEstimate = this.calculateBaseTokens(analysis);
    
    // Apply content-specific multipliers with refined accuracy
    tokenEstimate = this.applyContentMultipliers(tokenEstimate, analysis);
    
    // Apply machine learning adjustments based on historical data
    if (sessionId) {
      tokenEstimate = this.applyMLAdjustments(tokenEstimate, analysis, sessionId);
    }
    
    // Record performance metrics
    if (sessionId) {
      this.recordPerformanceMetric(sessionId, 'token_estimation', Date.now() - startTime, tokenEstimate);
    }
    
    return Math.ceil(tokenEstimate);
  }
  
  private analyzeTextStructure(text: string): {
    chars: number;
    words: number;
    lines: number;
    sentences: number;
    paragraphs: number;
    codeBlocks: number;
    inlineCode: number;
    jsonBlocks: number;
    xmlTags: number;
    markdownHeaders: number;
    urls: number;
    emails: number;
    numbers: number;
    punctuation: number;
    unicodeChars: number;
    avgWordLength: number;
    avgLineLength: number;
    complexity: number;
  } {
    const chars = text.length;
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const lines = text.split('\n');
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
    
    const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
    const inlineCode = (text.match(/`[^`]+`/g) || []).length;
    const jsonBlocks = (text.match(/\{[\s\S]*?\}/g) || []).length;
    const xmlTags = (text.match(/<[^>]+>/g) || []).length;
    const markdownHeaders = (text.match(/^#+\s/gm) || []).length;
    const urls = (text.match(/https?:\/\/[^\s]+/g) || []).length;
    const emails = (text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) || []).length;
    const numbers = (text.match(/\b\d+(?:\.\d+)?\b/g) || []).length;
    const punctuation = (text.match(/[.,;:!?\-()[\]{}"']/g) || []).length;
    // Count non-ASCII characters
    const unicodeChars = text.split('').filter(char => char.charCodeAt(0) > 127).length;
    
    const avgWordLength = words.length > 0 ? words.reduce((sum, word) => sum + word.length, 0) / words.length : 0;
    const avgLineLength = lines.length > 0 ? chars / lines.length : 0;
    
    // Complexity score based on various factors
    const complexity = this.calculateTextComplexity({
      avgWordLength,
      avgLineLength,
      sentenceLength: sentences.length > 0 ? words.length / sentences.length : 0,
      vocabularyDiversity: new Set(words.map(w => w.toLowerCase())).size / Math.max(words.length, 1),
      structuralElements: codeBlocks + jsonBlocks + xmlTags + markdownHeaders
    });
    
    return {
      chars, words: words.length, lines: lines.length, sentences: sentences.length, paragraphs: paragraphs.length,
      codeBlocks, inlineCode, jsonBlocks, xmlTags, markdownHeaders, urls, emails, numbers, punctuation, unicodeChars,
      avgWordLength, avgLineLength, complexity
    };
  }
  
  private calculateBaseTokens(analysis: ReturnType<typeof this.analyzeTextStructure>): number {
    // More sophisticated base calculation
    const charBasedEstimate = analysis.chars / 4;
    const wordBasedEstimate = analysis.words * 0.75;
    const unicodeAdjustment = analysis.unicodeChars * 0.3; // Unicode often requires more tokens
    
    // Weight different approaches based on text characteristics
    let baseEstimate = charBasedEstimate;
    
    if (analysis.avgWordLength > 8) {
      // Long words likely to be split into multiple tokens
      baseEstimate = Math.max(baseEstimate, wordBasedEstimate * 1.2);
    } else if (analysis.avgWordLength < 4) {
      // Short words might be more efficient
      baseEstimate = Math.min(baseEstimate, wordBasedEstimate * 1.1);
    } else {
      baseEstimate = Math.max(baseEstimate, wordBasedEstimate);
    }
    
    return baseEstimate + unicodeAdjustment;
  }
  
  private applyContentMultipliers(baseEstimate: number, analysis: ReturnType<typeof this.analyzeTextStructure>): number {
    let estimate = baseEstimate;
    
    // Code content multipliers (refined)
    if (analysis.codeBlocks > 0) {
      estimate *= 1.25 + (analysis.codeBlocks * 0.05); // Escalating complexity
    }
    
    if (analysis.inlineCode > 0) {
      estimate *= 1.1 + (analysis.inlineCode * 0.01);
    }
    
    // Structured data multipliers
    if (analysis.jsonBlocks > 2) {
      estimate *= 1.15 + (analysis.jsonBlocks * 0.02);
    }
    
    if (analysis.xmlTags > 5) {
      estimate *= 1.1 + (analysis.xmlTags * 0.01);
    }
    
    // URL and email handling (more precise)
    estimate += analysis.urls * 3; // URLs typically 3-5 tokens
    estimate += analysis.emails * 2; // Emails typically 2-3 tokens
    
    // Markdown formatting
    estimate += analysis.markdownHeaders * 1.2;
    
    // Punctuation density adjustment
    const punctuationDensity = analysis.punctuation / Math.max(analysis.chars, 1);
    if (punctuationDensity > 0.05) {
      estimate *= 1.05 + punctuationDensity; // Heavy punctuation increases token count
    }
    
    // Complexity-based adjustment
    if (analysis.complexity > 0.7) {
      estimate *= 1.1;
    } else if (analysis.complexity < 0.3) {
      estimate *= 0.95;
    }
    
    return estimate;
  }
  
  private calculateTextComplexity(metrics: {
    avgWordLength: number;
    avgLineLength: number;
    sentenceLength: number;
    vocabularyDiversity: number;
    structuralElements: number;
  }): number {
    // Normalize metrics to 0-1 scale and combine
    const wordComplexity = Math.min(metrics.avgWordLength / 10, 1);
    const lineComplexity = Math.min(metrics.avgLineLength / 100, 1);
    const sentenceComplexity = Math.min(metrics.sentenceLength / 20, 1);
    const vocabularyComplexity = Math.min(metrics.vocabularyDiversity, 1);
    const structuralComplexity = Math.min(metrics.structuralElements / 10, 1);
    
    return (wordComplexity + lineComplexity + sentenceComplexity + vocabularyComplexity + structuralComplexity) / 5;
  }
  
  private applyMLAdjustments(baseEstimate: number, analysis: ReturnType<typeof this.analyzeTextStructure>, sessionId: string): number {
    const analytics = this.analyticsData.get(sessionId);
    if (!analytics || analytics.tokenEstimationAccuracy.length < 3) {
      return baseEstimate; // Not enough data for ML adjustments
    }
    
    // Calculate average estimation accuracy
    const avgAccuracy = analytics.tokenEstimationAccuracy.reduce((sum, acc) => sum + acc, 0) / analytics.tokenEstimationAccuracy.length;
    
    // Adjust based on historical accuracy
    if (avgAccuracy > 1.1) {
      // We tend to overestimate, reduce by up to 10%
      return baseEstimate * (1 - Math.min(0.1, (avgAccuracy - 1) * 0.5));
    } else if (avgAccuracy < 0.9) {
      // We tend to underestimate, increase by up to 15%
      return baseEstimate * (1 + Math.min(0.15, (1 - avgAccuracy) * 0.75));
    }
    
    return baseEstimate;
  }
  
  private recordPerformanceMetric(sessionId: string, operation: string, duration: number, tokens: number): void {
    let analytics = this.analyticsData.get(sessionId);
    if (!analytics) {
      analytics = {
        tokenEstimationAccuracy: [],
        performanceMetrics: []
      };
      this.analyticsData.set(sessionId, analytics);
    }
    
    analytics.performanceMetrics.push({
      timestamp: Date.now(),
      operation,
      duration,
      tokens
    });
    
    // Keep only recent metrics to prevent memory bloat
    if (analytics.performanceMetrics.length > 100) {
      analytics.performanceMetrics = analytics.performanceMetrics.slice(-50);
    }
  }

  trackMessage(sessionId: string, content: string, type: 'user' | 'assistant' = 'user'): ContextWarning | null {
    const tokens = this.estimateTokens(content, sessionId);
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

  // Enhanced cleanup with analytics preservation and detailed reporting
  cleanupOldSessions(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    let totalMemoryFreed = 0;
    const cleanupReport: Array<{
      sessionId: string;
      tokens: number;
      messages: number;
      age: number;
      efficiency: number;
    }> = [];
    
    for (const [sessionId, stats] of this.sessions.entries()) {
      const sessionAge = now - stats.lastUpdate.getTime();
      
      if (sessionAge > maxAge) {
        const efficiency = stats.messages > 0 ? stats.estimatedTokens / stats.messages : 0;
        
        cleanupReport.push({
          sessionId,
          tokens: stats.estimatedTokens,
          messages: stats.messages,
          age: Math.round(sessionAge / 1000 / 60), // minutes
          efficiency: Math.round(efficiency)
        });
        
        totalMemoryFreed += stats.estimatedTokens;
        this.sessions.delete(sessionId);
        
        // Preserve analytics data for a longer period
        const analytics = this.analyticsData.get(sessionId);
        if (analytics && sessionAge < maxAge * 7) { // Keep analytics for 7x longer
          // Keep the analytics but mark session as archived
          this.log(`Preserving analytics for archived session: ${sessionId}`);
        } else {
          this.analyticsData.delete(sessionId);
        }
        
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.log(`\u267e\ufe0f Cleaned up ${cleaned} old sessions, freed ~${totalMemoryFreed} tokens`);
      
      if (this.debug) {
        this.log(`Cleanup report: ${JSON.stringify(cleanupReport, null, 2)}`);
      }
      
      // Log cleanup statistics
      const avgEfficiency = cleanupReport.length > 0 
        ? cleanupReport.reduce((sum, r) => sum + r.efficiency, 0) / cleanupReport.length
        : 0;
      
      this.log(`Average session efficiency: ${Math.round(avgEfficiency)} tokens/message`);
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