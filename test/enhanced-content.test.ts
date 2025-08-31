import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Client } from '@zed-industries/agent-client-protocol';
import { ClaudeACPAgent } from '../src/agent.js';
import type { 
  EnhancedContentBlock,
  ImageContentBlock,
  AudioContentBlock,
  ResourceContentBlock,
  DiffContentBlock,
  MIME_TYPE_MAPPINGS
} from '../src/types.js';

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

describe('Enhanced Content Block Support', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
  });

  describe('Content Type Detection', () => {
    it('should detect file operations from tool names', () => {
      // Access private method for testing
      const isFileOperation = (agent as any).isFileOperation;
      
      expect(isFileOperation('Read', 'some output')).toBe(true);
      expect(isFileOperation('Write', 'some output')).toBe(true);
      expect(isFileOperation('Edit', 'some output')).toBe(true);
      expect(isFileOperation('MultiEdit', 'some output')).toBe(true);
      expect(isFileOperation('Glob', 'some output')).toBe(true);
      expect(isFileOperation('Bash', 'some output')).toBe(false);
    });

    it('should detect file operations from output patterns', () => {
      const isFileOperation = (agent as any).isFileOperation;
      
      // Line number format (Read tool)
      expect(isFileOperation(undefined, '    1→import { test } from "test"')).toBe(true);
      
      // Edit tool output
      expect(isFileOperation(undefined, 'Applied 1 edit to file.ts')).toBe(true);
      
      // Write tool output  
      expect(isFileOperation(undefined, 'Created file src/test.ts')).toBe(true);
      
      // File path patterns
      expect(isFileOperation(undefined, '/path/to/file.ts')).toBe(true);
      expect(isFileOperation(undefined, '/path/to/file.py')).toBe(true);
      
      expect(isFileOperation(undefined, 'regular text')).toBe(false);
    });

    it('should detect diff output', () => {
      const isDiffOutput = (agent as any).isDiffOutput;
      
      expect(isDiffOutput('Applied 1 edit to file.ts', 'Edit')).toBe(true);
      expect(isDiffOutput('Applied 2 edits to file.ts', 'MultiEdit')).toBe(true);
      expect(isDiffOutput('+ added line\\n- removed line', undefined)).toBe(true);
      expect(isDiffOutput('@@ -1,3 +1,4 @@', undefined)).toBe(true);
      expect(isDiffOutput('diff --git a/file.ts b/file.ts', undefined)).toBe(true);
      
      expect(isDiffOutput('regular output', 'Edit')).toBe(false);
      expect(isDiffOutput('regular text', undefined)).toBe(false);
    });
  });

  describe('Resource Content Creation', () => {
    it('should create resource content for file operations with valid paths', () => {
      const createResourceContent = (agent as any).createResourceContent.bind(agent);
      
      // Test with a path that matches the expected pattern
      const result = createResourceContent('/path/to/test.ts', 'Read');
      
      expect(result).toEqual({
        type: 'resource_link',
        uri: 'file:///path/to/test.ts',
        name: 'test.ts',
        mimeType: 'text/typescript',
        description: 'Read operation: test.ts'
      });
    });

    it('should detect MIME types correctly for recognized patterns', () => {
      const createResourceContent = (agent as any).createResourceContent.bind(agent);
      
      // Test with paths that match the regex patterns
      const jsResult = createResourceContent('/path/to/file.js', 'Write');
      expect(jsResult?.mimeType).toBe('text/javascript');
      
      const pyResult = createResourceContent('/path/to/script.py', 'Edit');
      expect(pyResult?.mimeType).toBe('text/python');
      
      const jsonResult = createResourceContent('/path/to/data.json', 'Read');
      expect(jsonResult?.mimeType).toBe('application/json');
      
      // Test with unknown extension
      const unknownResult = createResourceContent('/path/to/file.unknown', 'Read');
      expect(unknownResult?.mimeType).toBe('text/plain');
    });

    it('should extract file paths from various output formats', () => {
      const createResourceContent = (agent as any).createResourceContent.bind(agent);
      
      // Line number format
      const readOutput = '    1→import { test } from "test"\\n    2→// Some code';
      let result = createResourceContent(readOutput, 'Read');
      expect(result).toBe(null); // No explicit path in this format
      
      // Explicit file path
      const filePathOutput = '/Users/user/project/src/main.ts';
      result = createResourceContent(filePathOutput, 'Edit');
      expect(result?.name).toBe('main.ts');
      expect(result?.uri).toBe('file:///Users/user/project/src/main.ts');
    });

    it('should handle missing or invalid file paths', () => {
      const createResourceContent = (agent as any).createResourceContent.bind(agent);
      
      const result = createResourceContent('No file path here', 'Read');
      expect(result).toBe(null);
      
      const emptyResult = createResourceContent('', 'Write');
      expect(emptyResult).toBe(null);
    });
  });

  describe('Media Content Detection', () => {
    it('should detect base64 image content', async () => {
      const detectMediaContent = (agent as any).detectMediaContent;
      
      const base64ImageOutput = 'Here is an image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const result = await detectMediaContent(base64ImageOutput);
      
      expect(result).toEqual({
        type: 'text',
        text: '[Image detected: png format]'
      });
    });

    it('should detect base64 audio content', async () => {
      const detectMediaContent = (agent as any).detectMediaContent;
      
      const base64AudioOutput = 'Audio data: data:audio/mp3;base64,SUQzAwAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjIwLjEwMAAAAAAAAAAAAAAA';
      const result = await detectMediaContent(base64AudioOutput);
      
      expect(result).toEqual({
        type: 'text',
        text: '[Audio detected: mp3 format]'
      });
    });

    it('should detect image file paths', async () => {
      const detectMediaContent = (agent as any).detectMediaContent;
      
      const imageFileOutput = 'Created image at /path/to/image.png';
      const result = await detectMediaContent(imageFileOutput);
      
      expect(result).toEqual({
        type: 'resource_link',
        uri: 'file://path/to/image.png',
        name: 'image.png',
        mimeType: 'image/png',
        description: 'Image file: path/to/image.png'
      });
    });

    it('should detect audio file paths', async () => {
      const detectMediaContent = (agent as any).detectMediaContent;
      
      const audioFileOutput = 'Generated audio file: /sounds/music.mp3';
      const result = await detectMediaContent(audioFileOutput);
      
      expect(result).toEqual({
        type: 'resource_link',
        uri: 'file://sounds/music.mp3',
        name: 'music.mp3',
        mimeType: 'audio/mpeg',
        description: 'Audio file: sounds/music.mp3'
      });
    });

    it('should return null for non-media content', async () => {
      const detectMediaContent = (agent as any).detectMediaContent;
      
      const textOutput = 'This is just regular text output';
      const result = await detectMediaContent(textOutput);
      
      expect(result).toBe(null);
    });
  });

  describe('Tool Output Processing', () => {
    it('should process tool output and create appropriate content blocks', async () => {
      // Bind the method properly
      const processToolOutputContent = (agent as any).processToolOutputContent.bind(agent);
      
      // Test file operation
      const fileOutput = '/path/to/test.ts';
      const fileResult = await processToolOutputContent(fileOutput, 'Read');
      
      expect(fileResult).toHaveLength(1);
      expect(fileResult[0].type).toBe('content');
      expect(fileResult[0].content.type).toBe('text');
      expect(fileResult[0].content.text).toContain('[+]');
      
      // Test diff output
      const diffOutput = 'Applied 1 edit to file.ts';
      const diffResult = await processToolOutputContent(diffOutput, 'Edit');
      
      expect(diffResult).toHaveLength(1);
      expect(diffResult[0].type).toBe('content');
      expect(diffResult[0].content.type).toBe('text');
      // Edit tool output is treated as file operation, not diff
      expect(diffResult[0].content.text).toContain(diffOutput);
    });

    it('should fallback to text content for unrecognized output', async () => {
      // Bind the method properly
      const processToolOutputContent = (agent as any).processToolOutputContent.bind(agent);
      
      const regularOutput = 'This is regular tool output';
      const result = await processToolOutputContent(regularOutput, 'SomeTool');
      
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('content');
      expect(result[0].content.type).toBe('text');
      expect(result[0].content.text).toBe('This is regular tool output');
    });

    it('should handle errors gracefully', async () => {
      // Bind the method properly
      const processToolOutputContent = (agent as any).processToolOutputContent.bind(agent);
      
      // Mock error in content processing
      vi.spyOn(agent as any, 'createResourceContent').mockImplementation(() => {
        throw new Error('Test error');
      });
      
      const result = await processToolOutputContent('/path/to/file.ts', 'Read');
      
      // Should fallback to default content
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('content');
      expect(result[0].content.type).toBe('text');
    });

    it('should enhance WebSearch output with metadata', async () => {
      // Bind the method properly
      const processToolOutputContent = (agent as any).processToolOutputContent.bind(agent);
      
      const searchOutput = 'Found 5 results for "TypeScript tutorial"\nhttps://www.typescriptlang.org/docs\nhttps://github.com/microsoft/TypeScript';
      const result = await processToolOutputContent(searchOutput, 'WebSearch');
      
      expect(result).toHaveLength(1);
      expect(result[0].content.text).toContain('[◊] Web Search Results');
      expect(result[0].content.text).toContain('5 results');
      expect(result[0].content.text).toContain('typescriptlang.org');
    });

    it('should enhance WebFetch output with content info', async () => {
      // Bind the method properly
      const processToolOutputContent = (agent as any).processToolOutputContent.bind(agent);
      
      const fetchOutput = 'Fetched content from https://example.com/api\nContent-Type: application/json\n{"data": "example"}';
      const result = await processToolOutputContent(fetchOutput, 'WebFetch');
      
      expect(result).toHaveLength(1);
      expect(result[0].content.text).toContain('[⬇] Web Content Fetched');
      expect(result[0].content.text).toContain('from example.com');
      expect(result[0].content.text).toContain('JSON');
    });
  });

  describe('File Operation Detection', () => {
    it('should detect correct operation types', () => {
      const detectFileOperation = (agent as any).detectFileOperation;
      
      expect(detectFileOperation('Read', undefined)).toBe('read');
      expect(detectFileOperation('Write', undefined)).toBe('write');
      expect(detectFileOperation('Edit', undefined)).toBe('edit');
      expect(detectFileOperation('MultiEdit', undefined)).toBe('edit');
      expect(detectFileOperation('Glob', undefined)).toBe('search');
      expect(detectFileOperation('UnknownTool', undefined)).toBe('unknown');
      
      // From output patterns
      expect(detectFileOperation(undefined, 'Applied 1 edit to file.ts')).toBe('edit');
      expect(detectFileOperation(undefined, 'Created file test.ts')).toBe('write');
      expect(detectFileOperation(undefined, '    1→code content')).toBe('read');
      expect(detectFileOperation(undefined, 'unknown output')).toBe('unknown');
    });
  });
});

describe('MIME Type Mappings', () => {
  it('should have correct MIME type mappings', async () => {
    // Import the actual mappings for testing
    const { MIME_TYPE_MAPPINGS } = await import('../src/types.js');
    
    expect(MIME_TYPE_MAPPINGS['.ts']).toBe('text/typescript');
    expect(MIME_TYPE_MAPPINGS['.js']).toBe('text/javascript');
    expect(MIME_TYPE_MAPPINGS['.py']).toBe('text/python');
    expect(MIME_TYPE_MAPPINGS['.json']).toBe('application/json');
    expect(MIME_TYPE_MAPPINGS['.png']).toBe('image/png');
    expect(MIME_TYPE_MAPPINGS['.jpg']).toBe('image/jpeg');
    expect(MIME_TYPE_MAPPINGS['.mp3']).toBe('audio/mpeg');
    expect(MIME_TYPE_MAPPINGS['.wav']).toBe('audio/wav');
    expect(MIME_TYPE_MAPPINGS['.pdf']).toBe('application/pdf');
  });

  it('should cover common file extensions', async () => {
    const { MIME_TYPE_MAPPINGS } = await import('../src/types.js');
    
    // Check that we have a good coverage of file types
    const extensions = Object.keys(MIME_TYPE_MAPPINGS);
    
    expect(extensions).toContain('.html');
    expect(extensions).toContain('.css');
    expect(extensions).toContain('.md');
    expect(extensions).toContain('.txt');
    expect(extensions).toContain('.cpp');
    expect(extensions).toContain('.java');
  });
});

describe('Extended Tool Kind Mapping', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
  });

  describe('Specialized Tool Mapping', () => {
    it('should map exact tool names correctly', () => {
      const mapToolKind = (agent as any).mapToolKind.bind(agent);
      
      // File operations
      expect(mapToolKind('Read')).toBe('read');
      expect(mapToolKind('Glob')).toBe('read');
      expect(mapToolKind('LS')).toBe('read');
      
      // Edit operations
      expect(mapToolKind('Write')).toBe('edit');
      expect(mapToolKind('Edit')).toBe('edit');
      expect(mapToolKind('MultiEdit')).toBe('edit');
      expect(mapToolKind('NotebookEdit')).toBe('edit');
      
      // Search operations
      expect(mapToolKind('Grep')).toBe('search');
      expect(mapToolKind('WebSearch')).toBe('search');
      
      // Execute operations
      expect(mapToolKind('Bash')).toBe('execute');
      expect(mapToolKind('KillBash')).toBe('execute');
      expect(mapToolKind('BashOutput')).toBe('execute');
      
      // Fetch operations
      expect(mapToolKind('WebFetch')).toBe('fetch');
      
      // Think operations
      expect(mapToolKind('TodoWrite')).toBe('think');
      expect(mapToolKind('ExitPlanMode')).toBe('think');
    });

    it('should map MCP tools correctly', () => {
      const mapToolKind = (agent as any).mapToolKind.bind(agent);
      
      expect(mapToolKind('mcp__chrome-browser__chrome_navigate')).toBe('fetch');
      expect(mapToolKind('mcp__chrome-browser__chrome_get_web_content')).toBe('read');
      expect(mapToolKind('mcp__chrome-browser__chrome_click_element')).toBe('execute');
      expect(mapToolKind('mcp__chrome-browser__chrome_fill_or_select')).toBe('execute');
      expect(mapToolKind('mcp__server__create_resource')).toBe('edit');
      expect(mapToolKind('mcp__server__search_documents')).toBe('search');
    });
  });
});

describe('Enhanced Client Capabilities', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
  });

  describe('Capability Detection', () => {
    it('should detect enhanced content support based on file system capabilities', () => {
      const detectExtendedCapabilities = (agent as any).detectExtendedCapabilities.bind(agent);
      
      const params1 = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true
          }
        }
      };
      
      const result1 = detectExtendedCapabilities(params1);
      expect(result1.experimental?.enhancedContent).toBe(true);
      expect(result1.experimental?.resourceMetadata).toBe(true);
      expect(result1.experimental?.richDiffs).toBe(true);
    });

    it('should always enable timing and progress capabilities', () => {
      const detectExtendedCapabilities = (agent as any).detectExtendedCapabilities.bind(agent);
      
      const params = {
        protocolVersion: 1,
        clientCapabilities: {}
      };
      
      const result = detectExtendedCapabilities(params);
      expect(result.experimental?.toolTiming).toBe(true);
      expect(result.experimental?.progressUpdates).toBe(true);
    });
  });
});

describe('Tool Execution Timing', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
    
    // Enable timing capabilities
    (agent as any).extendedClientCapabilities = {
      experimental: {
        toolTiming: true
      }
    };
  });

  describe('Duration Estimation', () => {
    it('should estimate durations for different tool types', () => {
      const estimateToolDuration = (agent as any).estimateToolDuration.bind(agent);
      
      expect(estimateToolDuration('Read')).toBe(500);
      expect(estimateToolDuration('Edit')).toBe(1000);
      expect(estimateToolDuration('MultiEdit')).toBe(2000);
      expect(estimateToolDuration('Bash')).toBe(3000);
      expect(estimateToolDuration('WebFetch')).toBe(5000);
      expect(estimateToolDuration('mcp__test')).toBe(2000);
      expect(estimateToolDuration('UnknownTool')).toBe(1500);
    });
  });

  describe('Timing Lifecycle', () => {
    it('should start and complete timing correctly', () => {
      const startToolTiming = (agent as any).startToolTiming.bind(agent);
      const completeToolTiming = (agent as any).completeToolTiming.bind(agent);
      
      const toolCallId = 'test-tool-123';
      const toolName = 'Read';
      
      // Start timing
      startToolTiming(toolCallId, toolName);
      
      // Check timing was stored
      const toolExecutionTiming = (agent as any).toolExecutionTiming;
      const storedTiming = toolExecutionTiming.get(toolCallId);
      expect(storedTiming).toBeDefined();
      expect(storedTiming?.startTime).toBeDefined();
      expect(storedTiming?.estimatedDuration).toBe(500);
      
      // Complete timing
      const result = completeToolTiming(toolCallId);
      expect(result).toBeDefined();
      expect(result?.duration).toBeDefined();
      expect(result?.endTime).toBeDefined();
      
      // Check timing was cleaned up
      expect(toolExecutionTiming.has(toolCallId)).toBe(false);
    });
  });
});

describe('Enhanced Diff Support', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
    
    // Enable rich diffs
    (agent as any).extendedClientCapabilities = {
      experimental: {
        richDiffs: true
      }
    };
  });

  describe('Language Detection', () => {
    it('should detect programming languages from file paths', () => {
      const detectLanguageFromPath = (agent as any).detectLanguageFromPath.bind(agent);
      
      expect(detectLanguageFromPath('/path/to/file.ts')).toBe('typescript');
      expect(detectLanguageFromPath('/path/to/file.js')).toBe('javascript');
      expect(detectLanguageFromPath('/path/to/script.py')).toBe('python');
      expect(detectLanguageFromPath('/path/to/main.java')).toBe('java');
      expect(detectLanguageFromPath('/path/to/app.cpp')).toBe('cpp');
      expect(detectLanguageFromPath('/path/to/style.css')).toBe('css');
      expect(detectLanguageFromPath('/path/to/readme.md')).toBe('markdown');
      expect(detectLanguageFromPath('/path/to/data.json')).toBe('json');
      expect(detectLanguageFromPath('/path/to/config.yaml')).toBe('yaml');
      expect(detectLanguageFromPath('/path/to/script.sh')).toBe('bash');
    });
  });

  describe('Diff Metadata Parsing', () => {
    it('should parse Edit tool output correctly', () => {
      const parseDiffMetadata = (agent as any).parseDiffMetadata.bind(agent);
      
      const editOutput = 'Applied 1 edit to /path/to/file.ts';
      const metadata = parseDiffMetadata(editOutput, 'Edit');
      
      expect(metadata.linesAdded).toBe(1);
      expect(metadata.linesRemoved).toBe(0);
      expect(metadata.language).toBe('typescript');
      expect(metadata.encoding).toBe('utf-8');
    });

    it('should parse unified diff format', () => {
      const parseDiffMetadata = (agent as any).parseDiffMetadata.bind(agent);
      
      const diffOutput = `--- a/test.py
+++ b/test.py
@@ -1,3 +1,4 @@
 def hello():
+    print("Hello, World!")
-    pass
     return True`;
     
      const metadata = parseDiffMetadata(diffOutput);
      
      expect(metadata.linesAdded).toBe(1);
      expect(metadata.linesRemoved).toBe(1);
      expect(metadata.language).toBe('python');
    });
  });
});

describe('Enhanced Resource Metadata', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
    
    // Enable resource metadata
    (agent as any).extendedClientCapabilities = {
      experimental: {
        resourceMetadata: true
      }
    };
  });

  describe('Metadata Generation', () => {
    it('should generate metadata from file operation output', () => {
      const generateResourceMetadata = (agent as any).generateResourceMetadata.bind(agent);
      
      const output = `Reading /path/to/file.ts
File size: 1234 bytes
Encoding: UTF-8
Last modified: 2025-08-31T12:00:00Z
Permissions: -rw-r--r--`;

      const metadata = generateResourceMetadata(output, '/path/to/file.ts', 'Read');
      
      expect(metadata.size).toBe(1234);
      expect(metadata.encoding).toBe('utf-8');
      expect(metadata.language).toBe('typescript');
      expect(metadata.lastModified).toBe('2025-08-31T12:00:00.000Z');
      expect(metadata.permissions).toBe('-rw-r--r--');
    });

    it('should estimate size for Read operations', () => {
      const generateResourceMetadata = (agent as any).generateResourceMetadata.bind(agent);
      
      const output = `    1→import { test } from 'test';
    2→// Some code
    3→export default test;`;

      const metadata = generateResourceMetadata(output, '/path/to/file.js', 'Read');
      
      expect(metadata.size).toBe(240); // 3 lines * 80 chars
      expect(metadata.language).toBe('javascript');
      expect(metadata.encoding).toBe('utf-8');
    });
  });
});

describe('Streaming Content Support', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
    
    // Enable streaming capabilities
    (agent as any).extendedClientCapabilities = {
      experimental: {
        streamingContent: true
      }
    };
  });

  describe('Streaming Decision Logic', () => {
    it('should enable streaming for long-running tools', () => {
      const shouldEnableStreaming = (agent as any).shouldEnableStreaming.bind(agent);
      
      expect(shouldEnableStreaming('Bash')).toBe(true);
      expect(shouldEnableStreaming('WebFetch')).toBe(true);
      expect(shouldEnableStreaming('WebSearch')).toBe(true);
      expect(shouldEnableStreaming('MultiEdit')).toBe(true);
      expect(shouldEnableStreaming('mcp__chrome-browser__navigate')).toBe(true);
      
      expect(shouldEnableStreaming('Read')).toBe(false);
      expect(shouldEnableStreaming('Write')).toBe(false);
    });

    it('should not enable streaming when capability is disabled', () => {
      (agent as any).extendedClientCapabilities = {
        experimental: {
          streamingContent: false
        }
      };
      
      const shouldEnableStreaming = (agent as any).shouldEnableStreaming.bind(agent);
      expect(shouldEnableStreaming('Bash')).toBe(false);
    });
  });

  describe('Streaming Lifecycle', () => {
    it('should start and manage streaming updates', () => {
      const startStreaming = (agent as any).startStreaming.bind(agent);
      const addStreamingChunk = (agent as any).addStreamingChunk.bind(agent);
      const completeStreaming = (agent as any).completeStreaming.bind(agent);
      
      const toolCallId = 'stream-test-123';
      const sessionId = 'test-session';
      
      // Start streaming
      startStreaming(toolCallId, 1000);
      
      // Check streaming was initialized
      const streamingUpdates = (agent as any).streamingUpdates;
      expect(streamingUpdates.has(toolCallId)).toBe(true);
      
      // Add chunks
      addStreamingChunk(toolCallId, 'chunk1\n', sessionId);
      addStreamingChunk(toolCallId, 'chunk2\n', sessionId);
      
      const streaming = streamingUpdates.get(toolCallId);
      expect(streaming.chunks).toEqual(['chunk1\n', 'chunk2\n']);
      
      // Complete streaming
      const fullContent = completeStreaming(toolCallId, sessionId);
      expect(fullContent).toBe('chunk1\nchunk2\n');
      expect(streamingUpdates.has(toolCallId)).toBe(false);
    });
  });
});

describe('Tool Call Batching Support', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
    
    // Enable batching capabilities
    (agent as any).extendedClientCapabilities = {
      experimental: {
        toolCallBatching: true
      }
    };
  });

  describe('Batching Decision Logic', () => {
    it('should decide to batch file operations', () => {
      const shouldBatchToolCalls = (agent as any).shouldBatchToolCalls.bind(agent);
      
      // Mostly file operations - should batch
      expect(shouldBatchToolCalls(['Read', 'Edit', 'Write'])).toBe(true);
      expect(shouldBatchToolCalls(['Glob', 'Read', 'MultiEdit'])).toBe(true);
      
      // Mixed operations - should not batch
      expect(shouldBatchToolCalls(['Read', 'WebFetch', 'Bash'])).toBe(false);
      
      // Too few operations
      expect(shouldBatchToolCalls(['Read'])).toBe(false);
    });

    it('should not batch when capability is disabled', () => {
      (agent as any).extendedClientCapabilities = {
        experimental: {
          toolCallBatching: false
        }
      };
      
      const shouldBatchToolCalls = (agent as any).shouldBatchToolCalls.bind(agent);
      expect(shouldBatchToolCalls(['Read', 'Edit', 'Write'])).toBe(false);
    });
  });

  describe('Batch Management', () => {
    it('should create and manage tool call batches', () => {
      const createToolCallBatch = (agent as any).createToolCallBatch.bind(agent);
      const updateBatchedToolCall = (agent as any).updateBatchedToolCall.bind(agent);
      const isBatchComplete = (agent as any).isBatchComplete.bind(agent);
      
      const toolCalls = [
        { id: 'tool1', name: 'Read', input: { file_path: '/test1.ts' } },
        { id: 'tool2', name: 'Edit', input: { file_path: '/test2.ts' } },
      ];
      
      const batch = createToolCallBatch(toolCalls, 'sequential');
      
      expect(batch.batchId).toBeDefined();
      expect(batch.batchType).toBe('sequential');
      expect(batch.toolCalls).toHaveLength(2);
      expect(batch.metadata?.totalOperations).toBe(2);
      
      // Check batch is tracked
      const activeBatches = (agent as any).activeBatches;
      expect(activeBatches.has(batch.batchId)).toBe(true);
      
      // Update tool call status
      updateBatchedToolCall(batch.batchId, 'tool1', 'completed', 'output1');
      updateBatchedToolCall(batch.batchId, 'tool2', 'completed', 'output2');
      
      expect(isBatchComplete(batch.batchId)).toBe(true);
      
      const updatedBatch = activeBatches.get(batch.batchId);
      expect(updatedBatch?.metadata?.completedOperations).toBe(2);
    });

    it('should generate unique batch IDs', () => {
      const generateBatchId = (agent as any).generateBatchId.bind(agent);
      
      const id1 = generateBatchId();
      const id2 = generateBatchId();
      
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^batch_\d+_[a-z0-9]+$/);
    });
  });
});

describe('Granular Diff Hunks', () => {
  let agent: ClaudeACPAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeACPAgent(mockClient);
    
    // Enable rich diffs
    (agent as any).extendedClientCapabilities = {
      experimental: {
        richDiffs: true
      }
    };
  });

  describe('Unified Diff Parsing', () => {
    it('should parse unified diff into granular hunks', () => {
      const parseUnifiedDiffHunks = (agent as any).parseUnifiedDiffHunks.bind(agent);
      
      const diffOutput = `--- a/test.py
+++ b/test.py
@@ -1,4 +1,4 @@
 def hello():
-    pass
+    print("Hello, World!")
     return True
@@ -10,6 +10,7 @@
 def goodbye():
+    print("Goodbye!")
     return False`;

      const hunks = parseUnifiedDiffHunks(diffOutput);
      
      expect(hunks).toHaveLength(2);
      
      // First hunk
      const hunk1 = hunks[0];
      expect(hunk1.oldStart).toBe(1);
      expect(hunk1.oldLength).toBe(4);
      expect(hunk1.newStart).toBe(1);
      expect(hunk1.newLength).toBe(4);
      expect(hunk1.changes).toHaveLength(4);
      expect(hunk1.metadata?.linesAdded).toBe(1);
      expect(hunk1.metadata?.linesRemoved).toBe(1);
      expect(hunk1.metadata?.linesContext).toBe(2);
      
      // Check individual changes
      const changes = hunk1.changes;
      expect(changes[0].type).toBe('context');
      expect(changes[0].content).toBe('def hello():');
      expect(changes[1].type).toBe('remove');
      expect(changes[1].content).toBe('    pass');
      expect(changes[2].type).toBe('add');
      expect(changes[2].content).toBe('    print("Hello, World!")');
      expect(changes[3].type).toBe('context');
      expect(changes[3].content).toBe('    return True');
      
      // Second hunk
      const hunk2 = hunks[1];
      expect(hunk2.oldStart).toBe(10);
      expect(hunk2.changes).toHaveLength(3); // Context line + added line + context line
    });

    it('should calculate correct line numbers for changes', () => {
      const parseUnifiedDiffHunks = (agent as any).parseUnifiedDiffHunks.bind(agent);
      
      const diffOutput = `@@ -5,3 +5,4 @@
 line 5
+new line
 line 6
 line 7`;

      const hunks = parseUnifiedDiffHunks(diffOutput);
      const hunk = hunks[0];
      const changes = hunk.changes;
      
      expect(changes[0].oldLineNumber).toBe(5);
      expect(changes[0].newLineNumber).toBe(5);
      expect(changes[1].newLineNumber).toBe(6);
      expect(changes[2].oldLineNumber).toBe(6);
      expect(changes[2].newLineNumber).toBe(7);
    });
  });

  describe('Enhanced Diff Metadata', () => {
    it('should include hunks in diff metadata when rich diffs enabled', () => {
      const parseDiffMetadata = (agent as any).parseDiffMetadata.bind(agent);
      
      const diffOutput = `--- a/test.py
+++ b/test.py
@@ -1,3 +1,4 @@
 def hello():
+    print("Hello!")
-    pass
     return True`;

      const metadata = parseDiffMetadata(diffOutput);
      
      expect(metadata.linesAdded).toBe(1);
      expect(metadata.linesRemoved).toBe(1);
      expect(metadata.language).toBe('python');
      expect(metadata.hunks).toBeDefined();
      expect(metadata.hunks).toHaveLength(1);
      
      const hunk = metadata.hunks![0];
      expect(hunk.changes).toHaveLength(4);
      expect(hunk.metadata?.linesAdded).toBe(1);
      expect(hunk.metadata?.linesRemoved).toBe(1);
    });

    it('should fallback gracefully for non-unified diff formats', () => {
      const parseDiffMetadata = (agent as any).parseDiffMetadata.bind(agent);
      
      const diffOutput = 'Applied 1 edit to test.py';
      const metadata = parseDiffMetadata(diffOutput, 'Edit');
      
      expect(metadata.linesAdded).toBe(1);
      expect(metadata.linesRemoved).toBe(0);
      expect(metadata.language).toBe('python');
      expect(metadata.hunks).toBeUndefined(); // No hunks for Edit tool
    });
  });
});