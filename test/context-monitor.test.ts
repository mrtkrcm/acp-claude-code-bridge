import { describe, it, expect, beforeEach } from 'vitest'
import { ContextMonitor } from '../src/context-monitor.js'

describe('ContextMonitor', () => {
  let monitor: ContextMonitor

  beforeEach(() => {
    monitor = new ContextMonitor(false) // debug mode off for tests
  })

  describe('Token Estimation', () => {
    it('should estimate tokens for simple text', () => {
      const warning = monitor.addMessage('test-session', 'Hello world', 'user')
      expect(warning).toBeNull() // Should be well under limits
      
      const stats = monitor.getStats('test-session')
      expect(stats).toBeDefined()
      expect(stats!.estimatedTokens).toBeGreaterThan(0)
      expect(stats!.messages).toBe(1)
      expect(stats!.turnCount).toBe(1)
    })

    it('should estimate more tokens for code blocks', () => {
      const codeText = '```javascript\nfunction hello() {\n  console.log("Hello world");\n  return "test";\n  const x = 123;\n}\n```'
      monitor.addMessage('test-session', codeText, 'user')
      
      const plainText = 'This is plain text with the same length'
      monitor.addMessage('test-session-2', plainText, 'user')
      
      const codeStats = monitor.getStats('test-session')
      const plainStats = monitor.getStats('test-session-2')
      
      expect(codeStats!.estimatedTokens).toBeGreaterThan(plainStats!.estimatedTokens)
    })

    it('should handle URLs and JSON correctly', () => {
      const urlText = 'Check out https://example.com and https://another-site.com'
      const jsonText = '{"name": "test", "value": 42, "nested": {"array": [1,2,3]}}'
      
      monitor.addMessage('url-session', urlText, 'user')
      monitor.addMessage('json-session', jsonText, 'user')
      
      const urlStats = monitor.getStats('url-session')
      const jsonStats = monitor.getStats('json-session')
      
      expect(urlStats!.estimatedTokens).toBeGreaterThan(10)
      expect(jsonStats!.estimatedTokens).toBeGreaterThan(5)
    })
  })

  describe('Context Warnings', () => {
    it('should not warn for small messages', () => {
      const warning = monitor.addMessage('test-session', 'Short message', 'user')
      expect(warning).toBeNull()
    })

    it('should warn at high usage', () => {
      const sessionId = 'high-usage-session'
      
      // Add a large message to trigger warning (need 80% of 200k = 160k tokens = 640k chars)
      const largeMessage = 'x'.repeat(640000) // Should trigger warning at ~80% usage
      const warning = monitor.addMessage(sessionId, largeMessage, 'user')
      
      expect(warning).not.toBeNull()
      expect(warning!.level).toBe('warning')
      expect(warning!.usage).toBeGreaterThanOrEqual(0.8) // Above or at warning threshold
    })

    it('should show critical warning near limit', () => {
      const sessionId = 'critical-session'
      
      // Add an even larger message to trigger critical warning (need 95% of 200k = 190k tokens = 760k chars)
      const massiveMessage = 'x'.repeat(760000) // Should trigger critical at ~95% usage
      const warning = monitor.addMessage(sessionId, massiveMessage, 'user')
      
      expect(warning).not.toBeNull()
      expect(warning!.level).toBe('critical')
      expect(warning!.usage).toBeGreaterThanOrEqual(0.95) // Above or at critical threshold
      expect(warning!.message).toContain('critical')
    })
  })

  describe('Session Management', () => {
    it('should track multiple sessions independently', () => {
      monitor.addMessage('session-1', 'Message for session 1', 'user')
      monitor.addMessage('session-2', 'Message for session 2', 'user')
      
      const stats1 = monitor.getStats('session-1')
      const stats2 = monitor.getStats('session-2')
      
      expect(stats1).toBeDefined()
      expect(stats2).toBeDefined()
      expect(stats1!.messages).toBe(1)
      expect(stats2!.messages).toBe(1)
    })

    it('should track assistant vs user messages correctly', () => {
      const sessionId = 'turn-tracking'
      
      monitor.addMessage(sessionId, 'User message', 'user')
      monitor.addMessage(sessionId, 'Assistant response', 'assistant')
      monitor.addMessage(sessionId, 'Another user message', 'user')
      
      const stats = monitor.getStats(sessionId)
      expect(stats!.messages).toBe(3)
      expect(stats!.turnCount).toBe(2) // Only user messages increment turn count
    })

    it('should reset session correctly', () => {
      const sessionId = 'reset-test'
      
      monitor.addMessage(sessionId, 'Some message', 'user')
      let stats = monitor.getStats(sessionId)
      expect(stats!.messages).toBe(1)
      expect(stats!.estimatedTokens).toBeGreaterThan(0)
      
      monitor.resetSession(sessionId)
      stats = monitor.getStats(sessionId)
      expect(stats!.messages).toBe(0)
      expect(stats!.estimatedTokens).toBe(0)
      expect(stats!.turnCount).toBe(0)
    })

    it('should clear session completely', () => {
      const sessionId = 'clear-test'
      
      monitor.addMessage(sessionId, 'Some message', 'user')
      expect(monitor.getStats(sessionId)).toBeDefined()
      
      monitor.clearSession(sessionId)
      expect(monitor.getStats(sessionId)).toBeNull()
    })
  })

  describe('Session Summaries', () => {
    it('should generate readable session summary', () => {
      const sessionId = 'summary-test'
      
      monitor.addMessage(sessionId, 'Test message', 'user')
      monitor.addMessage(sessionId, 'Assistant response', 'assistant')
      
      const summary = monitor.getSessionSummary(sessionId)
      expect(summary).toContain('[✓]') // Should show good status
      expect(summary).toMatch(/\d+K\/\d+K/) // Should contain token counts like "0.1K/200K"
      expect(summary).toContain('1 turn') // Only user messages count as turns
    })

    it('should show warning status in summary for high usage', () => {
      const sessionId = 'warning-summary'
      
      // Add large message to trigger warning (80%+ usage)
      monitor.addMessage(sessionId, 'x'.repeat(640000), 'user')
      
      const summary = monitor.getSessionSummary(sessionId)
      expect(summary).toContain('[WARNING]') // Warning marker
      expect(summary).toContain('HIGH') // HIGH usage indicator
    })
  })

  describe('Memory Management', () => {
    it('should provide memory statistics', () => {
      monitor.addMessage('session-1', 'Message 1', 'user')
      monitor.addMessage('session-2', 'Message 2', 'user') 
      monitor.addMessage('session-1', 'Message 3', 'assistant')
      
      const memoryStats = monitor.getMemoryStats()
      expect(memoryStats.activeSessions).toBe(2)
      expect(memoryStats.totalMessages).toBe(3)
      expect(memoryStats.totalTokens).toBeGreaterThan(0)
      expect(memoryStats.averageTokensPerSession).toBeGreaterThan(0)
    })

    it('should cleanup old sessions', async () => {
      // Add some sessions
      monitor.addMessage('old-session', 'Old message', 'user')
      monitor.addMessage('recent-session', 'Recent message', 'user')
      
      // Wait a small amount to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // Cleanup sessions older than 5ms (should clean all)
      const cleanedCount = monitor.cleanupOldSessions(5)
      expect(cleanedCount).toBe(2)
      
      // Verify sessions are gone
      expect(monitor.getStats('old-session')).toBeNull()
      expect(monitor.getStats('recent-session')).toBeNull()
    })
  })
})