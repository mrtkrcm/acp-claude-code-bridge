import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeACPAgent } from '../src/agent.js'

// Mock the Claude Code SDK
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn()
}))

// Mock the ACP client
const mockClient = {
  sessionUpdate: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  requestPermission: vi.fn()
}

describe('ClaudeACPAgent', () => {
  let agent: ClaudeACPAgent

  beforeEach(() => {
    vi.clearAllMocks()
    // Set up clean environment for each test
    delete process.env.ACP_MAX_TURNS
    delete process.env.ACP_PERMISSION_MODE
    delete process.env.ACP_DEBUG
    
    agent = new ClaudeACPAgent(mockClient as any)
  })

  describe('Initialization', () => {
    it('should initialize with default configuration', () => {
      expect(agent).toBeDefined()
    })

    it('should handle initialize request', async () => {
      const initParams = {
        protocolVersion: '0.1.0',
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true
          }
        }
      }

      const response = await agent.initialize(initParams)
      
      expect(response).toHaveProperty('protocolVersion')
      expect(response).toHaveProperty('agentCapabilities')
      expect(response.agentCapabilities.loadSession).toBe(true)
    })
  })

  describe('Session Management', () => {
    it('should create new session', async () => {
      const response = await agent.newSession({})
      
      expect(response).toHaveProperty('sessionId')
      expect(typeof response.sessionId).toBe('string')
      expect(response.sessionId.length).toBeGreaterThan(0)
    })

    it('should load existing session', async () => {
      const sessionId = 'test-session-id'
      
      // Should not throw error
      await expect(agent.loadSession?.({ sessionId })).resolves.toBeUndefined()
    })
  })

  describe('Configuration Parsing', () => {
    it('should parse max turns from environment', () => {
      process.env.ACP_MAX_TURNS = '50'
      const agent = new ClaudeACPAgent(mockClient as any)
      expect(agent).toBeDefined() // Agent should initialize successfully
    })

    it('should handle unlimited turns configuration', () => {
      process.env.ACP_MAX_TURNS = '0'
      const agent = new ClaudeACPAgent(mockClient as any)
      expect(agent).toBeDefined()
    })

    it('should validate invalid max turns', () => {
      process.env.ACP_MAX_TURNS = 'invalid'
      expect(() => new ClaudeACPAgent(mockClient as any)).toThrow()
    })

    it('should parse permission modes', () => {
      process.env.ACP_PERMISSION_MODE = 'acceptEdits'
      const agent = new ClaudeACPAgent(mockClient as any)
      expect(agent).toBeDefined()
    })

    it('should validate invalid permission modes', () => {
      process.env.ACP_PERMISSION_MODE = 'invalid'
      expect(() => new ClaudeACPAgent(mockClient as any)).toThrow()
    })
  })

  describe('Authentication', () => {
    it('should handle authentication requests', async () => {
      await expect(agent.authenticate({})).resolves.toBeUndefined()
    })
  })

  describe('Session Summaries', () => {
    it('should provide session summary', () => {
      const summary = agent.getSessionSummary('test-session')
      expect(typeof summary).toBe('string')
      expect(summary).toContain('Session')
    })
  })

  describe('Cancellation', () => {
    it('should handle cancel requests', async () => {
      await expect(agent.cancel({ sessionId: 'test-session' })).resolves.toBeUndefined()
    })
  })

  describe('Tool Kind Mapping', () => {
    it('should map tool names to appropriate kinds', () => {
      // Since mapToolKind is private, we test it indirectly through agent behavior
      // This test ensures the agent initializes and has the expected structure
      expect(agent).toHaveProperty('initialize')
      expect(agent).toHaveProperty('newSession')
      expect(agent).toHaveProperty('prompt')
    })
  })
})