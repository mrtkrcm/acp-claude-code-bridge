import type { ToolOperationContext, ToolCallLocation, ToolCallContent } from "../types.js";
import { createLogger, type Logger } from "../logger.js";

/**
 * Enhanced tool operation analysis and formatting
 */
export class ToolEnhancer {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger('ToolEnhancer');
  }

  /**
   * Analyzes tool operation context from tool name and input
   */
  analyzeToolOperation(toolName: string, input: unknown): ToolOperationContext {
    const context: ToolOperationContext = {
      toolName,
      input,
      operationType: this.inferOperationType(toolName, input),
      affectedFiles: this.extractAffectedFiles(input),
      complexity: this.assessComplexity(toolName, input)
    };

    this.logger.debug(`Analyzed tool operation: ${toolName} -> ${context.operationType} (${context.complexity})`);
    return context;
  }

  /**
   * Infers operation type from tool name and input
   */
  private inferOperationType(toolName: string, _input: unknown): ToolOperationContext['operationType'] {
    const toolLower = toolName.toLowerCase();

    // File operations
    if (toolLower.includes('read') || toolLower.includes('cat') || toolLower.includes('show')) {
      return 'read';
    }
    if (toolLower.includes('write') || toolLower.includes('create') || toolLower.includes('edit')) {
      return 'edit';
    }
    if (toolLower.includes('delete') || toolLower.includes('remove') || toolLower.includes('rm')) {
      return 'delete';
    }
    if (toolLower.includes('move') || toolLower.includes('mv') || toolLower.includes('rename')) {
      return 'move';
    }

    // Search operations
    if (toolLower.includes('grep') || toolLower.includes('search') || toolLower.includes('find')) {
      return 'search';
    }

    // Execution operations
    if (toolLower.includes('run') || toolLower.includes('exec') || toolLower.includes('bash')) {
      return 'execute';
    }

    // Web operations
    if (toolLower.includes('fetch') || toolLower.includes('curl') || toolLower.includes('web')) {
      return 'other';
    }

    return 'other';
  }

  /**
   * Extracts affected files from tool input
   */
  private extractAffectedFiles(input: unknown): string[] | undefined {
    if (!this.isValidInput(input)) return undefined;

    const files: string[] = [];

    // Common file path patterns
    const inputObj = input as Record<string, unknown>;

    // Direct file/path properties
    const fileProps = ['file', 'path', 'filepath', 'file_path', 'target', 'source', 'destination'];
    for (const prop of fileProps) {
      if (typeof inputObj[prop] === 'string') {
        files.push(inputObj[prop] as string);
      }
    }

    // Array properties that might contain files
    const arrayProps = ['files', 'paths', 'targets'];
    for (const prop of arrayProps) {
      if (Array.isArray(inputObj[prop])) {
        files.push(...(inputObj[prop] as string[]).filter(f => typeof f === 'string'));
      }
    }

    return files.length > 0 ? [...new Set(files)] : undefined;
  }

  /**
   * Assesses operation complexity
   */
  private assessComplexity(toolName: string, input: unknown): 'simple' | 'moderate' | 'complex' {
    const toolLower = toolName.toLowerCase();

    // Complex operations
    if (toolLower.includes('multiedit') || toolLower.includes('refactor')) {
      return 'complex';
    }

    // Moderate complexity
    if (toolLower.includes('search') || toolLower.includes('grep') ||
      toolLower.includes('run') || toolLower.includes('exec')) {
      return 'moderate';
    }

    // Check input complexity
    if (this.isValidInput(input)) {
      const inputObj = input as Record<string, unknown>;

      // Complex if has many properties or large arrays
      const propCount = Object.keys(inputObj).length;
      if (propCount > 5) return 'complex';
      if (propCount > 2) return 'moderate';

      // Check for large content
      for (const value of Object.values(inputObj)) {
        if (typeof value === 'string' && value.length > 1000) return 'complex';
        if (Array.isArray(value) && value.length > 10) return 'complex';
      }
    }

    return 'simple';
  }

  /**
   * Type guard for valid input objects
   */
  private isValidInput(input: unknown): input is Record<string, unknown> {
    return input !== null && typeof input === 'object' && !Array.isArray(input);
  }

  /**
   * Extracts tool locations for file tracking
   */
  extractToolLocations(context: ToolOperationContext): ToolCallLocation[] {
    const locations: ToolCallLocation[] = [];

    if (context.affectedFiles) {
      for (const filePath of context.affectedFiles) {
        locations.push({
          path: filePath,
          line: this.extractLineNumber(context.input)
        });
      }
    }

    return locations;
  }

  /**
   * Extracts line number from input
   */
  private extractLineNumber(input: unknown): number | undefined {
    if (this.isValidInput(input)) {
      const inputObj = input as Record<string, unknown>;
      const line = inputObj.line || inputObj.line_number || inputObj.start_line;
      return typeof line === 'number' ? line : undefined;
    }
    return undefined;
  }

  /**
   * Extracts column number from input
   */
  private extractColumnNumber(input: unknown): number | undefined {
    if (this.isValidInput(input)) {
      const inputObj = input as Record<string, unknown>;
      const col = inputObj.column || inputObj.col || inputObj.start_column;
      return typeof col === 'number' ? col : undefined;
    }
    return undefined;
  }

  /**
   * Generates enhanced tool title
   */
  generateEnhancedToolTitle(context: ToolOperationContext): string {
    const { toolName, operationType, affectedFiles } = context;

    let title = toolName;

    if (operationType && operationType !== 'other') {
      title = `${operationType.charAt(0).toUpperCase() + operationType.slice(1)} ${toolName}`;
    }

    if (affectedFiles && affectedFiles.length > 0) {
      const fileCount = affectedFiles.length;
      if (fileCount === 1) {
        title += ` (${this.getFileName(affectedFiles[0])})`;
      } else {
        title += ` (${fileCount} files)`;
      }
    }

    return title;
  }

  /**
   * Gets filename from path
   */
  private getFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
  }

  /**
   * Generates enhanced tool content with diff support
   */
  generateEnhancedToolContent(context: ToolOperationContext, output: string): ToolCallContent[] {
    const { toolName, operationType } = context;

    // For edit operations, try to create diff content
    if (operationType === 'edit' && output) {
      return this.createDiffContent(output, toolName);
    }

    // For read operations, enhance with syntax highlighting
    if (operationType === 'read' && output) {
      return this.createReadContent(output, context);
    }

    // Default content
    return [{
      type: "content",
      content: { type: "text", text: output }
    }];
  }

  /**
   * Creates diff content for edit operations
   */
  private createDiffContent(output: string, _toolName: string): ToolCallContent[] {
    const lines = output.split('\n');
    const content: ToolCallContent[] = [];

    let currentBlock = '';
    let blockType = 'text';

    for (const line of lines) {
      if (line.startsWith('+')) {
        if (blockType !== 'addition') {
          if (currentBlock) {
            content.push(this.createContentBlock(currentBlock, blockType));
          }
          currentBlock = line;
          blockType = 'addition';
        } else {
          currentBlock += '\n' + line;
        }
      } else if (line.startsWith('-')) {
        if (blockType !== 'deletion') {
          if (currentBlock) {
            content.push(this.createContentBlock(currentBlock, blockType));
          }
          currentBlock = line;
          blockType = 'deletion';
        } else {
          currentBlock += '\n' + line;
        }
      } else {
        if (blockType !== 'text') {
          if (currentBlock) {
            content.push(this.createContentBlock(currentBlock, blockType));
          }
          currentBlock = line;
          blockType = 'text';
        } else {
          currentBlock += '\n' + line;
        }
      }
    }

    if (currentBlock) {
      content.push(this.createContentBlock(currentBlock, blockType));
    }

    return content;
  }

  /**
   * Creates a content block
   */
  private createContentBlock(text: string, _type: string): ToolCallContent {
    // TODO: Fix annotations schema to support diff annotations
    return {
      type: "content",
      content: {
        type: "text",
        text
      }
    };
  }

  /**
   * Creates read content with syntax highlighting
   */
  private createReadContent(output: string, context: ToolOperationContext): ToolCallContent[] {
    const filePath = context.affectedFiles?.[0];
    const highlightedOutput = this.addSyntaxHighlighting(output, filePath);

    return [{
      type: "content",
      content: {
        type: "text",
        text: highlightedOutput
      }
    }];
  }

  /**
   * Adds syntax highlighting based on file type
   */
  private addSyntaxHighlighting(content: string, filePath?: string): string {
    if (!filePath) return content;

    const ext = this.getFileExtension(filePath).toLowerCase();

    switch (ext) {
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx':
        return this.highlightJavaScript(content);
      case 'py':
        return this.highlightPython(content);
      case 'json':
        return this.highlightJSON(content);
      case 'md':
        return this.highlightMarkdown(content);
      default:
        return content;
    }
  }

  /**
   * Gets file extension
   */
  private getFileExtension(filePath: string): string {
    return filePath.split('.').pop() || '';
  }

  /**
   * Highlights JavaScript/TypeScript code
   */
  private highlightJavaScript(code: string): string {
    return code
      .replace(/\b(function|const|let|var|if|else|for|while|return|class|import|export)\b/g, '\x1b[34m$1\x1b[0m') // Keywords
      .replace(/\b(console|Math|Date|Array|Object|String|Number|Boolean)\b/g, '\x1b[32m$1\x1b[0m') // Built-ins
      .replace(/(["'`])(.*?)\1/g, '\x1b[33m$1$2$1\x1b[0m') // Strings
      .replace(/\/\/(.*)/g, '\x1b[90m//$1\x1b[0m') // Comments
      .replace(/\/\*[\s\S]*?\*\//g, '\x1b[90m$&\x1b[0m'); // Block comments
  }

  /**
   * Highlights Python code
   */
  private highlightPython(code: string): string {
    return code
      .replace(/\b(def|class|if|elif|else|for|while|return|import|from|try|except|finally)\b/g, '\x1b[34m$1\x1b[0m') // Keywords
      .replace(/\b(print|len|range|str|int|float|list|dict|set)\b/g, '\x1b[32m$1\x1b[0m') // Built-ins
      .replace(/(["'`])(.*?)\1/g, '\x1b[33m$1$2$1\x1b[0m') // Strings
      .replace(/#(.*)/g, '\x1b[90m#$1\x1b[0m'); // Comments
  }

  /**
   * Highlights JSON
   */
  private highlightJSON(code: string): string {
    return code
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        (match) => {
          if (/^"/.test(match)) {
            if (/:$/.test(match)) {
              return '\x1b[33m' + match + '\x1b[0m'; // Keys
            } else {
              return '\x1b[32m' + match + '\x1b[0m'; // Values
            }
          }
          return '\x1b[34m' + match + '\x1b[0m'; // Numbers, booleans, null
        });
  }

  /**
   * Highlights Markdown
   */
  private highlightMarkdown(text: string): string {
    return text
      .replace(/^(#{1,6})\s+(.+)$/gm, '\x1b[34m$1\x1b[0m $2') // Headers
      .replace(/(\*\*|__)(.*?)\1/g, '\x1b[1m$2\x1b[0m') // Bold
      .replace(/(\*|_)(.*?)\1/g, '\x1b[3m$2\x1b[0m') // Italic
      .replace(/`([^`]+)`/g, '\x1b[32m`$1`\x1b[0m') // Inline code
      .replace(/```[\s\S]*?```/g, '\x1b[32m$&\x1b[0m') // Code blocks
      .replace(/^\s*[-*+]\s+/gm, '\x1b[33m•\x1b[0m '); // Lists
  }

  /**
   * Gets file type icon
   */
  getFileTypeIcon(filePath: string): string {
    const ext = this.getFileExtension(filePath).toLowerCase();

    const icons: Record<string, string> = {
      'js': '🟨',
      'ts': '🔷',
      'jsx': '⚛️',
      'tsx': '⚛️',
      'py': '🐍',
      'java': '☕',
      'cpp': '⚙️',
      'c': '⚙️',
      'go': '🐹',
      'rs': '🦀',
      'php': '🐘',
      'rb': '💎',
      'html': '🌐',
      'css': '🎨',
      'json': '📋',
      'xml': '📄',
      'yaml': '📄',
      'yml': '📄',
      'md': '📝',
      'txt': '📄',
      'sql': '🗄️',
      'sh': '⚡',
      'dockerfile': '🐳',
      'gitignore': '🚫',
      'lock': '🔒'
    };

    return icons[ext] || '📄';
  }

  /**
   * Formats error output
   */
  formatErrorOutput(context: ToolOperationContext, error: string | Error, errorCode?: string): string {
    const toolName = context.toolName;
    const errorMsg = error instanceof Error ? error.message : error;
    const code = errorCode ? ` (${errorCode})` : '';

    return `[ERROR] ${toolName}${code}: ${errorMsg}`;
  }

  /**
   * Formats tool output with enhanced display
   */
  formatToolOutput(context: ToolOperationContext, output: string): string {
    const { toolName, operationType, affectedFiles } = context;

    // Handle read operations
    if (operationType === 'read') {
      if (output.startsWith('[READ]') || output.startsWith('[READ]')) return output;
      const lines = output.split('\n').length;
      const chars = output.length;
      const filePath = affectedFiles?.[0] || 'file';
      const fileIcon = this.getFileTypeIcon(filePath);
      const highlightedOutput = this.addSyntaxHighlighting(output, filePath);
      return `[READ] ${fileIcon} ${filePath} (${lines} lines, ${chars} chars)\n${highlightedOutput}`;
    }

    // Handle specific tool types
    return this.formatSpecificToolOutput(toolName, output, context);
  }

  /**
   * Formats output for specific tool types
   */
  private formatSpecificToolOutput(toolName: string, output: string, context: ToolOperationContext): string {
    const toolNameLower = toolName.toLowerCase();
    const affectedFiles = context.affectedFiles || [];

    // Handle create operations
    if (toolNameLower.includes('create') || toolNameLower.includes('new')) {
      const createIcon = '➕';
      const filePath = affectedFiles[0] || 'file';
      return `[CREATE] ${createIcon} ${filePath}\n${output}`;
    }

    // Handle delete operations
    if (toolNameLower.includes('delete') || toolNameLower.includes('remove')) {
      const deleteIcon = '🗑️';
      const filePath = affectedFiles[0] || 'file';
      return `[DELETE] ${deleteIcon} ${filePath}\n${output}`;
    }

    // Handle edit operations
    if (toolNameLower.includes('edit') || toolNameLower.includes('write')) {
      const editIcon = '✏️';
      const filePath = affectedFiles[0] || 'file';
      return `[EDIT] ${editIcon} ${filePath}\n${output}`;
    }

    // Handle search operations
    if (toolNameLower.includes('grep') || toolNameLower.includes('search')) {
      return `[SEARCH] Pattern: ${this.extractSearchPattern(context.input) || 'unknown'}\n${output}`;
    }

    // Handle web operations
    if (toolNameLower.includes('fetch') || toolNameLower.includes('web')) {
      const url = this.extractUrl(context.input);
      const lines = output.split('\n').length;
      const chars = output.length;
      return `[WEBFETCH] ${url || 'URL'} (${lines} lines, ${chars} chars fetched)\n${output}`;
    }

    // Default formatting
    return `[${toolName.toUpperCase()}] ${output}`;
  }

  /**
   * Extracts search pattern from input
   */
  private extractSearchPattern(input: unknown): string | null {
    if (!this.isValidInput(input)) return null;

    const inputObj = input as Record<string, unknown>;
    const pattern = inputObj.pattern || inputObj.query || inputObj.search;
    return typeof pattern === 'string' ? pattern : null;
  }

  /**
   * Extracts URL from input
   */
  private extractUrl(input: unknown): string | null {
    if (!this.isValidInput(input)) return null;

    const inputObj = input as Record<string, unknown>;
    const url = inputObj.url || inputObj.uri || inputObj.address;
    return typeof url === 'string' ? url : null;
  }

  /**
   * Gets tool title
   */
  getToolTitle(toolName: string, _input?: unknown): string {
    // Enhanced tool titles with context
    const toolLower = toolName.toLowerCase();

    if (toolLower.includes('read') || toolLower.includes('cat')) {
      return 'File Reader';
    }
    if (toolLower.includes('write') || toolLower.includes('edit')) {
      return 'File Editor';
    }
    if (toolLower.includes('run') || toolLower.includes('exec')) {
      return 'Command Runner';
    }
    if (toolLower.includes('search') || toolLower.includes('grep')) {
      return 'Content Search';
    }
    if (toolLower.includes('fetch') || toolLower.includes('web')) {
      return 'Web Fetcher';
    }

    return toolName;
  }

  /**
   * Maps tool name to appropriate kind
   */
  mapToolKind(toolName: string): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other" {
    const toolLower = toolName.toLowerCase();

    if (toolLower.includes('read') || toolLower.includes('cat') || toolLower.includes('show')) {
      return 'read';
    }
    if (toolLower.includes('write') || toolLower.includes('edit') || toolLower.includes('create')) {
      return 'edit';
    }
    if (toolLower.includes('delete') || toolLower.includes('remove')) {
      return 'delete';
    }
    if (toolLower.includes('move') || toolLower.includes('rename')) {
      return 'move';
    }
    if (toolLower.includes('grep') || toolLower.includes('search') || toolLower.includes('find')) {
      return 'search';
    }
    if (toolLower.includes('run') || toolLower.includes('exec') || toolLower.includes('bash')) {
      return 'execute';
    }
    if (toolLower.includes('fetch') || toolLower.includes('curl') || toolLower.includes('web')) {
      return 'fetch';
    }
    if (toolLower.includes('think') || toolLower.includes('reason')) {
      return 'think';
    }

    return 'other';
  }
}
