import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CircuitBreaker, CircuitState } from '../src/circuit-breaker.js'
import { ResourceManager } from '../src/resource-manager.js'
import { ContextMonitor } from '../src/context-monitor.js'

describe('Safety Validation of Optimizations', () => {
  describe('Circuit Breaker Safety', () => {
    let circuitBreaker: CircuitBreaker<string, string>
    let mockFn: vi.MockedFunction<(args: string) => Promise<string>>

    beforeEach(() => {
      mockFn = vi.fn()
      circuitBreaker = new CircuitBreaker(mockFn, {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 100,
        monitoringPeriod: 1000
      })
    })

    it('should correctly transition from CLOSED to OPEN on failures', async () => {
      mockFn.mockRejectedValue(new Error('Service down'))
      
      // Generate failures to trip circuit
      for (let i = 0; i < 3; i++) {
        try { await circuitBreaker.execute('test') } catch {}
      }
      
      const stats = circuitBreaker.getStats()
      expect(stats.state).toBe(CircuitState.OPEN)
      expect(stats.failures).toBe(3)
      expect(stats.totalFailures).toBe(3)
    })

    it('should fail fast when circuit is OPEN', async () => {
      mockFn.mockRejectedValue(new Error('Service down'))
      
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        try { await circuitBreaker.execute('test') } catch {}
      }
      
      // Should fail fast without calling function
      const callsBefore = mockFn.mock.calls.length
      try {
        await circuitBreaker.execute('test')
      } catch (error) {
        expect(error.message).toContain('Circuit breaker is OPEN')
      }
      expect(mockFn.mock.calls.length).toBe(callsBefore)
    })

    it('should transition to HALF_OPEN after timeout', async () => {
      mockFn.mockRejectedValue(new Error('Service down'))
      
      // Trip circuit
      for (let i = 0; i < 3; i++) {
        try { await circuitBreaker.execute('test') } catch {}
      }
      
      // Wait for timeout + small buffer
      await new Promise(resolve => setTimeout(resolve, 150))
      
      mockFn.mockResolvedValue('success')
      await circuitBreaker.execute('test')
      
      const stats = circuitBreaker.getStats()
      expect(stats.successes).toBeGreaterThan(0)
    })
  })

  describe('Resource Manager Safety', () => {
    let resourceManager: ResourceManager

    beforeEach(() => {
      resourceManager = new ResourceManager({
        maxMemoryMB: 1024,
        maxConcurrentOperations: 10,
        maxConcurrentSessions: 3,
        memoryWarningThresholdMB: 256,
        memoryCriticalThresholdMB: 512
      })
    })

    afterEach(() => {
      resourceManager.destroy()
    })

    it('should enforce concurrent operation limits', () => {
      // Add operations up to limit
      for (let i = 0; i < 10; i++) {
        expect(resourceManager.startOperation(`op-${i}`)).toBe(true)
      }
      
      // Should reject 11th operation
      expect(resourceManager.startOperation('op-10')).toBe(false)
      
      // Should allow after finishing one
      resourceManager.finishOperation('op-0')
      expect(resourceManager.startOperation('op-10')).toBe(true)
    })

    it('should enforce session limits', () => {
      // Add sessions up to limit
      for (let i = 0; i < 3; i++) {
        expect(resourceManager.addSession(`session-${i}`)).toBe(true)
      }
      
      // Should reject 4th session
      expect(resourceManager.addSession('session-4')).toBe(false)
      
      // Should allow after removing one
      resourceManager.removeSession('session-0')
      expect(resourceManager.addSession('session-4')).toBe(true)
    })

    it('should provide accurate health status', () => {
      expect(resourceManager.getHealthStatus()).toBe('healthy')
      
      // Fill to warning level (80% of 10 = 8, so 9 > 8 triggers warning)
      for (let i = 0; i < 9; i++) {
        resourceManager.startOperation(`op-${i}`)
      }
      expect(resourceManager.getHealthStatus()).toBe('warning')
      
      // Fill to critical level (10 >= 10 triggers critical)
      resourceManager.startOperation('op-9')
      expect(resourceManager.getHealthStatus()).toBe('critical')
    })
  })

  describe('Context Monitor Safety', () => {
    let monitor: ContextMonitor

    beforeEach(() => {
      monitor = new ContextMonitor()
    })

    it('should accurately track token estimation', () => {
      monitor.addMessage('session1', 'Hello world', 'user')
      const stats = monitor.getStats('session1')
      
      expect(stats).toBeDefined()
      expect(stats!.estimatedTokens).toBeGreaterThan(0)
      expect(stats!.messages).toBe(1)
      expect(stats!.usage).toBeGreaterThan(0)
    })

    it('should properly handle warning thresholds', () => {
      // Add large message to trigger warning (80% of 200k = 160k tokens = 640k chars)
      const largeMessage = 'x'.repeat(640000)
      const warning = monitor.addMessage('session1', largeMessage, 'user')
      
      expect(warning).toBeDefined()
      expect(warning!.level).toBe('warning')
      expect(warning!.usage).toBeGreaterThanOrEqual(0.8)
    })

    it('should track turn counts correctly', () => {
      monitor.addMessage('session1', 'User message', 'user')
      monitor.addMessage('session1', 'Assistant response', 'assistant')
      monitor.addMessage('session1', 'Another user message', 'user')
      
      const stats = monitor.getStats('session1')
      expect(stats!.messages).toBe(3)
      expect(stats!.turnCount).toBe(2) // Only user messages count as turns
    })

    it('should isolate sessions properly', () => {
      monitor.addMessage('session1', 'Short message', 'user')
      monitor.addMessage('session2', 'This is a much longer message with more content', 'user')
      
      const stats1 = monitor.getStats('session1')
      const stats2 = monitor.getStats('session2')
      
      expect(stats1!.messages).toBe(1)
      expect(stats2!.messages).toBe(1)
      expect(stats1!.estimatedTokens).not.toBe(stats2!.estimatedTokens)
    })
  })
})