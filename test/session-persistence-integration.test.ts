import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ClaudeACPAgent } from '../src/agent.js'
import { SessionPersistenceManager, resetDefaultPersistenceManager } from '../src/session-persistence.js'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Session Persistence Integration Tests', () => {
  let agent: ClaudeACPAgent
  let testSessionsDir: string
  let originalSessionsDir: string

  beforeEach(async () => {
    // Create temporary sessions directory for testing
    testSessionsDir = join(tmpdir(), `acp-test-sessions-${Date.now()}`)
    await mkdir(testSessionsDir, { recursive: true })
    
    // Mock environment to use test directory
    originalSessionsDir = process.env.ACP_SESSIONS_DIR || ''
    process.env.ACP_SESSIONS_DIR = testSessionsDir
    
    // Reset default manager to pick up new environment
    resetDefaultPersistenceManager()
    
    agent = new ClaudeACPAgent('test-client')
  })

  afterEach(async () => {
    // Cleanup test directory
    if (existsSync(testSessionsDir)) {
      await rm(testSessionsDir, { recursive: true })
    }
    
    // Restore original sessions directory
    if (originalSessionsDir) {
      process.env.ACP_SESSIONS_DIR = originalSessionsDir
    } else {
      delete process.env.ACP_SESSIONS_DIR
    }
  })

  describe('Session Creation and Persistence', () => {
    it('should create and persist a new session', async () => {
      // Create new session (newSession generates its own ID)
      const response = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: []
      })
      const testSessionId = response.sessionId
      
      // Verify session file exists
      const sessionFile = join(testSessionsDir, `${testSessionId}.json`)
      expect(existsSync(sessionFile)).toBe(true)
      
      // Verify session data structure
      const persistence = new SessionPersistenceManager(testSessionsDir)
      const sessionData = await persistence.loadSession(testSessionId)
      
      expect(sessionData).toBeDefined()
      expect(sessionData!.sessionId).toBe(testSessionId)
      expect(sessionData!.permissionMode).toBeDefined()
      expect(sessionData!.createdAt).toBeDefined()
      expect(sessionData!.lastAccessed).toBeDefined()
    })

    it('should persist Claude session ID when obtained', async () => {
      const mockClaudeSessionId = 'claude-session-12345'
      
      // Create session
      const response = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: []
      })
      const testSessionId = response.sessionId
      
      // Simulate obtaining Claude session ID (this happens during first prompt)
      const session = (agent as any).sessions.get(testSessionId)
      if (session) {
        session.claudeSessionId = mockClaudeSessionId
        await (agent as any).persistSessionState(testSessionId)
      }
      
      // Verify Claude session ID is persisted
      const persistence = new SessionPersistenceManager(testSessionsDir)
      const sessionData = await persistence.loadSession(testSessionId)
      
      expect(sessionData!.claudeSessionId).toBe(mockClaudeSessionId)
    })
  })

  describe('Session Loading and Resume', () => {
    it('should load existing session from persistence', async () => {
      const testSessionId = 'test-session-003'
      const persistence = new SessionPersistenceManager(testSessionsDir)
      
      // Create persisted session data
      const sessionData = {
        sessionId: testSessionId,
        permissionMode: 'bypassPermissions' as const,
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        claudeSessionId: 'existing-claude-session-456',
        metadata: {
          userAgent: 'Test-Agent',
          version: '0.13.0'
        }
      }
      
      await persistence.saveSession(sessionData)
      
      // Load session through agent
      await agent.loadSession({ 
        sessionId: testSessionId,
        cwd: process.cwd(),
        mcpServers: []
      })
      
      // Verify session is loaded in memory
      const loadedSession = (agent as any).sessions.get(testSessionId)
      expect(loadedSession).toBeDefined()
      expect(loadedSession.claudeSessionId).toBe('existing-claude-session-456')
      expect(loadedSession.permissionMode).toBe('bypassPermissions')
    })

    it('should handle loading non-existent session gracefully', async () => {
      const nonExistentSessionId = 'non-existent-session'
      
      // Should not throw error
      await agent.loadSession({ 
        sessionId: nonExistentSessionId,
        cwd: process.cwd(),
        mcpServers: []
      })
      
      // Session should not be in memory since it wasn't found in persistence
      const session = (agent as any).sessions.get(nonExistentSessionId)
      expect(session).toBeUndefined()
    })
  })

  describe('Session State Updates', () => {
    it('should update session timestamp on activity', async () => {
      const persistence = new SessionPersistenceManager(testSessionsDir)
      
      // Create initial session
      const response = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: []
      })
      const testSessionId = response.sessionId
      
      const initialData = await persistence.loadSession(testSessionId)
      const initialTimestamp = initialData!.lastAccessed
      
      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // Update session (simulate activity)
      await (agent as any).persistSessionState(testSessionId)
      
      const updatedData = await persistence.loadSession(testSessionId)
      const updatedTimestamp = updatedData!.lastAccessed
      
      expect(updatedTimestamp).not.toBe(initialTimestamp)
      expect(new Date(updatedTimestamp) > new Date(initialTimestamp)).toBe(true)
    })

    it('should preserve all session metadata across updates', async () => {
      const persistence = new SessionPersistenceManager(testSessionsDir)
      
      const response = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: []
      })
      const testSessionId = response.sessionId
      
      // Get initial session and add metadata
      const session = (agent as any).sessions.get(testSessionId)
      if (session) {
        session.claudeSessionId = 'test-claude-session'
        session.permissionMode = 'acceptEdits'
      }
      
      await (agent as any).persistSessionState(testSessionId)
      
      // Load and verify all data preserved
      const sessionData = await persistence.loadSession(testSessionId)
      expect(sessionData!.sessionId).toBe(testSessionId)
      expect(sessionData!.claudeSessionId).toBe('test-claude-session')
      expect(sessionData!.permissionMode).toBe('acceptEdits')
      expect(sessionData!.metadata).toBeDefined()
    })
  })

  describe('Concurrent Session Operations', () => {
    it('should handle concurrent session saves safely', async () => {
      const response = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: []
      })
      const testSessionId = response.sessionId
      
      // Simulate concurrent updates
      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push((agent as any).persistSessionState(testSessionId))
      }
      
      // Should not throw errors
      await Promise.all(promises)
      
      // Session should still be valid
      const persistence = new SessionPersistenceManager(testSessionsDir)
      const sessionData = await persistence.loadSession(testSessionId)
      expect(sessionData).toBeDefined()
      expect(sessionData!.sessionId).toBe(testSessionId)
    })
  })

  describe('Session Cleanup', () => {
    it('should clean up old sessions', async () => {
      const persistence = new SessionPersistenceManager(testSessionsDir)
      
      // Create old session (1 hour ago)
      const oldSessionId = 'old-session'
      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
      
      await persistence.saveSession({
        sessionId: oldSessionId,
        permissionMode: 'default',
        createdAt: oldDate.toISOString(),
        lastAccessed: oldDate.toISOString(),
        metadata: { userAgent: 'Test', version: '0.13.0' }
      })
      
      // Create recent session
      const recentSessionId = 'recent-session'
      await persistence.saveSession({
        sessionId: recentSessionId,
        permissionMode: 'default',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        metadata: { userAgent: 'Test', version: '0.13.0' }
      })
      
      // Cleanup sessions older than 1 hour
      const cleanedCount = await persistence.cleanupInactiveSessions(60 * 60 * 1000)
      
      expect(cleanedCount).toBe(1)
      
      // Verify old session removed, recent session remains
      const oldSession = await persistence.loadSession(oldSessionId)
      const recentSession = await persistence.loadSession(recentSessionId)
      
      expect(oldSession).toBeNull()
      expect(recentSession).not.toBeNull()
    })
  })

  describe('Error Recovery', () => {
    it('should handle corrupted session files gracefully', async () => {
      const corruptedSessionId = 'corrupted-session'
      const sessionFile = join(testSessionsDir, `${corruptedSessionId}.json`)
      
      // Create corrupted JSON file
      await writeFile(sessionFile, '{"invalid": json content}')
      
      // Should not throw error when loading
      const persistence = new SessionPersistenceManager(testSessionsDir)
      const sessionData = await persistence.loadSession(corruptedSessionId)
      
      expect(sessionData).toBeNull()
    })

    it('should recover from missing sessions directory', async () => {
      // Remove test directory
      await rm(testSessionsDir, { recursive: true })
      
      // Should recreate directory and work normally
      const persistence = new SessionPersistenceManager(testSessionsDir)
      const testSessionId = 'recovery-test'
      
      await persistence.saveSession({
        sessionId: testSessionId,
        permissionMode: 'default',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        metadata: { userAgent: 'Test', version: '0.13.0' }
      })
      
      const sessionData = await persistence.loadSession(testSessionId)
      expect(sessionData).toBeDefined()
      expect(sessionData!.sessionId).toBe(testSessionId)
    })
  })
})