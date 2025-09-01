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
  requestPermission: vi.fn().mockResolvedValue({ 
    outcome: { outcome: 'selected', optionId: 'allow_once' } 
  })
} as Client;

describe('Enhanced ACP Features - Complete Implementation', () => {
  let agent: ClaudeACPAgent

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ACP_MAX_TURNS
    delete process.env.ACP_PERMISSION_MODE
    delete process.env.ACP_DEBUG
    
    agent = new ClaudeACPAgent(mockClient)
  })

  describe('Enhanced Capabilities Negotiation', () => {
    it('should advertise enhanced ACP capabilities', async () => {
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
      
      expect(response.agentCapabilities.loadSession).toBe(true)
      expect(response.agentCapabilities.promptCapabilities).toBeDefined()
      expect(response.agentCapabilities.promptCapabilities?.image).toBe(true)
      expect(response.agentCapabilities.promptCapabilities?.embeddedContext).toBe(true)
      expect(response.agentCapabilities.promptCapabilities?.audio).toBe(false)
    })
  })

  describe('Session Enhancement', () => {
    it('should create sessions with enhanced features', async () => {
      const sessionResponse = await agent.newSession({ 
        cwd: process.cwd(),
        mcpServers: []
      })
      
      expect(sessionResponse.sessionId).toBeDefined()
      expect(typeof sessionResponse.sessionId).toBe('string')
      
      // Test session has enhanced features
      const sessionStatus = agent['getSessionStatus'](sessionResponse.sessionId)
      expect(sessionStatus.active).toBe(true)
      expect(sessionStatus.features).toBeDefined()
      expect(typeof sessionStatus.features.thoughtStreaming).toBe('boolean')
      expect(typeof sessionStatus.features.activeFiles).toBe('number')
    })
  })

  describe('Prompt Complexity Analysis', () => {
    it('should identify simple prompts correctly', () => {
      const analysis = agent['analyzePromptComplexity']('What is 2+2?')
      
      expect(analysis.isComplex).toBe(false)
      expect(analysis.needsPlan).toBe(false)
      expect(analysis.estimatedSteps).toBe(1)
      expect(analysis.summary).toBe('Processing simple request')
    })

    it('should identify complex implementation prompts', () => {
      const complexPrompt = 'Implement a new authentication system with JWT tokens, user registration, password reset, and email verification functionality'
      const analysis = agent['analyzePromptComplexity'](complexPrompt)
      
      expect(analysis.isComplex).toBe(true)
      expect(analysis.needsPlan).toBe(true)
      expect(analysis.estimatedSteps).toBeGreaterThan(2)
      expect(analysis.summary).toContain('authentication system')
    })

    it('should identify multi-step prompts', () => {
      const multiStepPrompt = 'First, analyze the code structure, then refactor the authentication module, and finally run the tests'
      const analysis = agent['analyzePromptComplexity'](multiStepPrompt)
      
      expect(analysis.isComplex).toBe(true)
      expect(analysis.needsPlan).toBe(true)
      expect(analysis.estimatedSteps).toBeGreaterThan(2)
    })
  })

  describe('Tool Operation Analysis', () => {
    it('should analyze file operations correctly', () => {
      const context = agent['analyzeToolOperation']('Edit', {
        file_path: '/src/test.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;'
      })
      
      expect(context.toolName).toBe('Edit')
      expect(context.operationType).toBe('edit')
      expect(context.affectedFiles).toEqual(['/src/test.ts'])
      expect(context.complexity).toBe('simple')
    })

    it('should analyze command operations correctly', () => {
      const context = agent['analyzeToolOperation']('Bash', {
        command: 'rm -rf dangerous-folder'
      })
      
      expect(context.toolName).toBe('Bash')
      expect(context.operationType).toBe('execute')
      expect(context.complexity).toBe('moderate')
    })

    it('should detect complex operations with multiple files', () => {
      const context = agent['analyzeToolOperation']('MultiEdit', {
        files: ['/src/a.ts', '/src/b.ts', '/src/c.ts', '/src/d.ts']
      })
      
      expect(context.affectedFiles?.length).toBe(4)
      expect(context.complexity).toBe('complex')
    })
  })

  describe('Tool Location Tracking', () => {
    it('should extract file locations with line numbers', () => {
      const context = {
        toolName: 'Edit',
        input: { file_path: '/src/test.ts', line: 42 },
        operationType: 'edit' as const,
        affectedFiles: ['/src/test.ts']
      }
      
      const locations = agent['extractToolLocations'](context)
      
      expect(locations).toHaveLength(1)
      expect(locations[0].path).toBe('/src/test.ts')
      expect(locations[0].line).toBe(42)
    })

    it('should handle multiple file locations', () => {
      const context = {
        toolName: 'MultiEdit',
        input: {},
        operationType: 'edit' as const,
        affectedFiles: ['/src/a.ts', '/src/b.ts', '/src/c.ts']
      }
      
      const locations = agent['extractToolLocations'](context)
      
      expect(locations).toHaveLength(3)
      expect(locations.map(l => l.path)).toEqual(['/src/a.ts', '/src/b.ts', '/src/c.ts'])
    })
  })

  describe('Enhanced Tool Titles', () => {
    it('should generate enhanced titles for file operations', () => {
      const context = {
        toolName: 'Edit',
        input: { file_path: '/src/test.ts' },
        operationType: 'edit' as const,
        affectedFiles: ['/src/test.ts']
      }
      
      const title = agent['generateEnhancedToolTitle'](context)
      expect(title).toBe('Edit: /src/test.ts')
    })

    it('should generate enhanced titles for command operations', () => {
      const context = {
        toolName: 'Bash',
        input: { command: 'npm install lodash' },
        operationType: 'execute' as const
      }
      
      const title = agent['generateEnhancedToolTitle'](context)
      expect(title).toBe('Execute: npm install lodash')
    })

    it('should handle multiple files in title', () => {
      const context = {
        toolName: 'MultiEdit',
        input: {},
        operationType: 'edit' as const,
        affectedFiles: ['/src/a.ts', '/src/b.ts', '/src/c.ts']
      }
      
      const title = agent['generateEnhancedToolTitle'](context)
      expect(title).toBe('Edit: a.ts (+2 files)')
    })
  })

  describe('Tool Content Enhancement', () => {
    it('should generate diff content for file edits', () => {
      const context = {
        toolName: 'Edit',
        input: {
          file_path: '/src/test.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;'
        },
        operationType: 'edit' as const,
        affectedFiles: ['/src/test.ts']
      }
      
      const content = agent['generateEnhancedToolContent'](context, 'File updated')
      
      expect(content).toHaveLength(1)
      expect(content[0]).toEqual({
        type: 'diff',
        path: '/src/test.ts',
        oldText: 'const x = 1;',
        newText: 'const x = 2;'
      })
    })

    it('should generate diff content for file creation', () => {
      const context = {
        toolName: 'Write',
        input: {
          file_path: '/src/new.ts',
          content: 'export const hello = "world";'
        },
        operationType: 'create' as const,
        affectedFiles: ['/src/new.ts']
      }
      
      const content = agent['generateEnhancedToolContent'](context, 'File created')
      
      expect(content).toHaveLength(1)
      expect(content[0]).toEqual({
        type: 'diff',
        path: '/src/new.ts',
        oldText: null,
        newText: 'export const hello = "world";'
      })
    })

    it('should generate enhanced text content for other operations', () => {
      const context = {
        toolName: 'Bash',
        input: { command: 'ls -la' },
        operationType: 'execute' as const
      }
      
      const content = agent['generateEnhancedToolContent'](context, 'total 8\ndrwxr-xr-x  2 user  staff')
      
      expect(content).toHaveLength(1)
      expect(content[0].type).toBe('content')
      expect(content[0].content?.type).toBe('text')
      expect(content[0].content?.text).toBe('$ Command executed\ntotal 8\ndrwxr-xr-x  2 user  staff')
    })
  })

  describe('Content Annotations', () => {
    it('should generate appropriate annotations for different operation types', () => {
      const executeContext = {
        toolName: 'Bash',
        input: { command: 'rm file.txt' },
        operationType: 'execute' as const,
        complexity: 'moderate' as const
      }
      
      const annotations = agent['generateContentAnnotations'](executeContext, 'File deleted')
      
      expect(annotations.audience).toEqual(['user'])
      expect(annotations.priority).toBe(2)
    })

    it('should add timestamps for file operations', () => {
      const fileContext = {
        toolName: 'Edit',
        input: { file_path: '/src/test.ts' },
        operationType: 'edit' as const,
        affectedFiles: ['/src/test.ts'],
        complexity: 'simple' as const
      }
      
      const annotations = agent['generateContentAnnotations'](fileContext, 'File updated')
      
      expect(annotations.lastModified).toBeDefined()
      expect(typeof annotations.lastModified).toBe('string')
      expect(annotations.text).toBe(true)
    })
  })

  describe('Permission System Enhancement', () => {
    it('should identify auto-approvable operations', () => {
      const readContext = {
        toolName: 'Read',
        input: { file_path: '/src/test.ts' },
        operationType: 'read' as const
      }
      
      expect(agent['isAutoApprovableOperation'](readContext)).toBe(true)
      
      const deleteContext = {
        toolName: 'Delete',
        input: { file_path: '/src/test.ts' },
        operationType: 'delete' as const
      }
      
      expect(agent['isAutoApprovableOperation'](deleteContext)).toBe(false)
    })

    it('should identify operations requiring explicit permission', () => {
      const deleteContext = {
        toolName: 'Delete',
        input: { file_path: '/src/test.ts' },
        operationType: 'delete' as const,
        affectedFiles: ['/src/test.ts']
      }
      
      expect(agent['requiresExplicitPermission'](deleteContext)).toBe(true)
      
      const readContext = {
        toolName: 'Read', 
        input: { file_path: './src/test.ts' }, // Relative path within current directory
        operationType: 'read' as const,
        affectedFiles: ['./src/test.ts']
      }
      
      expect(agent['requiresExplicitPermission'](readContext)).toBe(false)
    })

    it('should generate appropriate permission options', () => {
      const deleteContext = {
        toolName: 'Delete',
        input: { file_path: '/src/test.ts' },
        operationType: 'delete' as const,
        affectedFiles: ['/src/test.ts']
      }
      
      const options = agent['generatePermissionOptions'](deleteContext)
      
      expect(options).toHaveLength(3) // No 'allow_always' for delete
      expect(options.map(o => o.optionId)).toEqual(['allow_once', 'reject_once', 'reject_always'])
      
      const editContext = {
        toolName: 'Edit',
        input: { file_path: '/src/test.ts' },
        operationType: 'edit' as const,
        affectedFiles: ['/src/test.ts']
      }
      
      const editOptions = agent['generatePermissionOptions'](editContext)
      expect(editOptions).toHaveLength(4) // Includes 'allow_always' for safe operations
    })
  })

  describe('Rich Content Support', () => {
    it('should create resource content blocks', () => {
      const resourceContent = agent['createResourceContent'](
        'file:///src/readme.md',
        'Project README',
        'Main project documentation'
      )
      
      expect(resourceContent.type).toBe('resource_link')
      expect(resourceContent.uri).toBe('file:///src/readme.md')
      expect(resourceContent.name).toBe('Project README')
      expect(resourceContent.description).toBe('Main project documentation')
      expect(resourceContent.annotations?.audience).toEqual(['user'])
    })
  })

  describe('Session Status Tracking', () => {
    it('should track session features correctly', () => {
      const sessionId = 'test-session-123'
      
      // Should handle non-existent session
      const emptyStatus = agent['getSessionStatus']('non-existent')
      expect(emptyStatus.active).toBe(false)
    })
  })

  describe('Input Validation', () => {
    it('should properly validate input types', () => {
      expect(agent['isValidInput']({ key: 'value' })).toBe(true)
      expect(agent['isValidInput'](['array'])).toBe(false)
      expect(agent['isValidInput'](null)).toBe(false)
      expect(agent['isValidInput']('string')).toBe(false)
      expect(agent['isValidInput'](123)).toBe(false)
    })
  })

  describe('Output Formatting', () => {
    it('should format outputs with appropriate visual indicators', () => {
      const createContext = {
        toolName: 'Write',
        input: { file_path: '/new.txt' },
        operationType: 'create' as const,
        affectedFiles: ['/new.txt']
      }
      expect(agent['formatToolOutput'](createContext, 'File created')).toBe('[✓] File created (/new.txt)\nFile created')
      
      const deleteContext = {
        toolName: 'Delete',
        input: { file_path: '/old.txt' },
        operationType: 'delete' as const,
        affectedFiles: ['/old.txt']
      }
      expect(agent['formatToolOutput'](deleteContext, 'File deleted')).toBe('[DEL] File deleted (/old.txt)\nFile deleted')
      
      const executeContext = {
        toolName: 'Bash',
        input: { command: 'ls' },
        operationType: 'execute' as const
      }
      expect(agent['formatToolOutput'](executeContext, 'file1.txt file2.txt')).toBe('$ Command executed\nfile1.txt file2.txt')
    })

    it('should not duplicate existing indicators', () => {
      const createContext = {
        toolName: 'Write',
        input: { file_path: '/new.txt' },
        operationType: 'create' as const
      }
      expect(agent['formatToolOutput'](createContext, '[✓] Already has checkmark')).toBe('[✓] Already has checkmark')
    })
  })
});