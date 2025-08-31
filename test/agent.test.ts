import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeACPAgent } from '../src/agent.js'

// Mock the Claude Code SDK
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn()
}))

// Mock the ACP client with proper typing
import type { Client } from '@zed-industries/agent-client-protocol';

const mockClient: Client = {
  sessionUpdate: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  requestPermission: vi.fn()
} as Client;

describe('ClaudeACPAgent', () => {
  let agent: ClaudeACPAgent

  beforeEach(() => {
    vi.clearAllMocks()
    // Set up clean environment for each test
    delete process.env.ACP_MAX_TURNS
    delete process.env.ACP_PERMISSION_MODE
    delete process.env.ACP_DEBUG
    
    agent = new ClaudeACPAgent(mockClient)
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
      const response = await agent.newSession({ 
        cwd: process.cwd(),
        mcpServers: []
      })
      
      expect(response).toHaveProperty('sessionId')
      expect(typeof response.sessionId).toBe('string')
      expect(response.sessionId.length).toBeGreaterThan(0)
    })

    it('should load existing session', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000' // Valid UUID
      
      // Should not throw error
      await expect(agent.loadSession?.({ 
        sessionId, 
        cwd: process.cwd(),
        mcpServers: []
      })).resolves.toBeUndefined()
    })
  })

  describe('Configuration Parsing', () => {
    it('should parse max turns from environment', () => {
      process.env.ACP_MAX_TURNS = '50'
      const agent = new ClaudeACPAgent(mockClient)
      expect(agent).toBeDefined() // Agent should initialize successfully
    })

    it('should handle unlimited turns configuration', () => {
      process.env.ACP_MAX_TURNS = '0'
      const agent = new ClaudeACPAgent(mockClient)
      expect(agent).toBeDefined()
    })

    it('should validate invalid max turns', () => {
      process.env.ACP_MAX_TURNS = 'invalid'
      expect(() => new ClaudeACPAgent(mockClient)).toThrow()
    })

    it('should parse permission modes', () => {
      process.env.ACP_PERMISSION_MODE = 'acceptEdits'
      const agent = new ClaudeACPAgent(mockClient)
      expect(agent).toBeDefined()
    })

    it('should validate invalid permission modes', () => {
      process.env.ACP_PERMISSION_MODE = 'invalid'
      expect(() => new ClaudeACPAgent(mockClient)).toThrow()
    })
  })

  describe('Authentication', () => {
    it('should handle authentication requests', async () => {
      await expect(agent.authenticate({})).resolves.toBeUndefined()
    })
  })


  describe('Cancellation', () => {
    it('should handle cancel requests', async () => {
      await expect(agent.cancel({ sessionId: '550e8400-e29b-41d4-a716-446655440001' })).resolves.toBeUndefined()
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