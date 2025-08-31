import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Client } from '@zed-industries/agent-client-protocol';
import { ClaudeACPAgent } from '../src/agent.js';
import type { ToolPermissionConfig, PermissionLevel } from '../src/types.js';

// Mock the client
const mockClient: Client = {
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  authenticate: vi.fn(),
  cancel: vi.fn(),
  prompt: vi.fn(),
  sessionUpdate: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  requestPermission: vi.fn(),
};

describe('Tool Permission System', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
  });

  describe('Permission Level Detection', () => {
    it('should detect denied tools from disallowedTools list', () => {
      const config: ToolPermissionConfig = {
        disallowedTools: ['Bash', 'Write'],
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      const getToolPermissionLevel = (agent as any).getToolPermissionLevel.bind(agent);
      expect(getToolPermissionLevel('Bash')).toBe('deny');
      expect(getToolPermissionLevel('Write')).toBe('deny');
      expect(getToolPermissionLevel('Read')).toBe('allow');
    });

    it('should only allow tools in allowedTools list when present', () => {
      const config: ToolPermissionConfig = {
        allowedTools: ['Read', 'Glob'],
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      const getToolPermissionLevel = (agent as any).getToolPermissionLevel.bind(agent);
      expect(getToolPermissionLevel('Read')).toBe('allow');
      expect(getToolPermissionLevel('Glob')).toBe('allow');
      expect(getToolPermissionLevel('Write')).toBe('deny');
      expect(getToolPermissionLevel('Bash')).toBe('deny');
    });

    it('should use per-tool permissions when specified', () => {
      const config: ToolPermissionConfig = {
        toolPermissions: {
          'Bash': 'ask',
          'Write': 'deny',
          'Read': 'allow'
        },
        defaultPermission: 'ask'
      };
      
      agent.updateToolPermissions(config);
      
      const getToolPermissionLevel = (agent as any).getToolPermissionLevel.bind(agent);
      expect(getToolPermissionLevel('Bash')).toBe('ask');
      expect(getToolPermissionLevel('Write')).toBe('deny');
      expect(getToolPermissionLevel('Read')).toBe('allow');
      expect(getToolPermissionLevel('Edit')).toBe('ask'); // default
    });

    it('should use default permission for unlisted tools', () => {
      const config: ToolPermissionConfig = {
        defaultPermission: 'deny'
      };
      
      agent.updateToolPermissions(config);
      
      const getToolPermissionLevel = (agent as any).getToolPermissionLevel.bind(agent);
      expect(getToolPermissionLevel('UnknownTool')).toBe('deny');
      
      // Update default
      config.defaultPermission = 'ask';
      agent.updateToolPermissions(config);
      expect(getToolPermissionLevel('UnknownTool')).toBe('ask');
    });

    it('should prioritize disallowedTools over allowedTools', () => {
      const config: ToolPermissionConfig = {
        allowedTools: ['Read', 'Write', 'Bash'],
        disallowedTools: ['Bash'],
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      const getToolPermissionLevel = (agent as any).getToolPermissionLevel.bind(agent);
      expect(getToolPermissionLevel('Read')).toBe('allow');
      expect(getToolPermissionLevel('Write')).toBe('allow');
      expect(getToolPermissionLevel('Bash')).toBe('deny'); // Disallowed takes precedence
    });
  });

  describe('Tool Allowed Checking', () => {
    it('should correctly identify allowed and denied tools', () => {
      const config: ToolPermissionConfig = {
        allowedTools: ['Read', 'Glob'],
        disallowedTools: ['Bash'],
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      expect((agent as any).isToolAllowed('Read')).toBe(true);
      expect((agent as any).isToolAllowed('Glob')).toBe(true);
      expect((agent as any).isToolAllowed('Bash')).toBe(false);
      expect((agent as any).isToolAllowed('Write')).toBe(false); // Not in allowed list
    });

    it('should handle tool permissions with ask level', () => {
      const config: ToolPermissionConfig = {
        toolPermissions: {
          'Edit': 'ask',
          'Write': 'deny'
        },
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      expect((agent as any).isToolAllowed('Edit')).toBe(true); // 'ask' is considered allowed
      expect((agent as any).isToolAllowed('Write')).toBe(false);
      expect((agent as any).isToolAllowed('Read')).toBe(true); // default allow
    });
  });

  describe('Permission Request Decision', () => {
    beforeEach(async () => {
      // Set up a mock session
      await agent.newSession({ 
        cwd: process.cwd(),
        mcpServers: []
      });
    });

    it('should request permission for denied tools', async () => {
      const config: ToolPermissionConfig = {
        disallowedTools: ['Bash'],
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      const shouldRequestPermission = (agent as any).shouldRequestPermissionForTool.bind(agent);
      const result = await shouldRequestPermission('test-session', 'Bash', {});
      
      expect(result).toBe(true);
    });

    it('should not request permission for explicitly allowed tools', async () => {
      const config: ToolPermissionConfig = {
        toolPermissions: {
          'Read': 'allow'
        },
        defaultPermission: 'ask'
      };
      
      agent.updateToolPermissions(config);
      
      const shouldRequestPermission = (agent as any).shouldRequestPermissionForTool.bind(agent);
      const result = await shouldRequestPermission('test-session', 'Read', {});
      
      expect(result).toBe(false);
    });

    it('should always request permission for ask-level tools', async () => {
      const config: ToolPermissionConfig = {
        toolPermissions: {
          'Edit': 'ask'
        },
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(config);
      
      const shouldRequestPermission = (agent as any).shouldRequestPermissionForTool.bind(agent);
      const result = await shouldRequestPermission('test-session', 'Edit', {});
      
      expect(result).toBe(true);
    });
  });

  describe('Configuration Updates', () => {
    it('should update tool permissions configuration', () => {
      const initialConfig: ToolPermissionConfig = {
        defaultPermission: 'allow'
      };
      
      agent.updateToolPermissions(initialConfig);
      expect(agent.getToolPermissions()).toEqual({
        defaultPermission: 'allow'
      });
      
      const updatedConfig: Partial<ToolPermissionConfig> = {
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash']
      };
      
      agent.updateToolPermissions(updatedConfig);
      expect(agent.getToolPermissions()).toEqual({
        defaultPermission: 'allow',
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash']
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty configurations', () => {
      const config: ToolPermissionConfig = {};
      agent.updateToolPermissions(config);
      
      const getToolPermissionLevel = (agent as any).getToolPermissionLevel.bind(agent);
      expect(getToolPermissionLevel('AnyTool')).toBe('allow'); // Default fallback
    });

    it('should handle case sensitivity', () => {
      const config: ToolPermissionConfig = {
        allowedTools: ['Read', 'write'], // Mixed case
        disallowedTools: ['BASH']
      };
      
      agent.updateToolPermissions(config);
      
      expect((agent as any).isToolAllowed('Read')).toBe(true);
      expect((agent as any).isToolAllowed('write')).toBe(true);
      expect((agent as any).isToolAllowed('BASH')).toBe(false);
      
      // Different case should be treated as different tool
      expect((agent as any).isToolAllowed('read')).toBe(false); // Not in allowed list
      expect((agent as any).isToolAllowed('bash')).toBe(false); // Not allowed by default when allowedTools exists
    });
  });
});