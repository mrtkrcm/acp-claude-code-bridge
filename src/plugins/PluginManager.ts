import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as os from 'node:os';

import { createLogger, type Logger } from "../logger.js";

// ========== PLUGIN ARCHITECTURE ==========

export interface PluginTool {
  name: string;
  description: string;
  version: string;
  capabilities: PluginCapability[];
  execute: (input: unknown, context: PluginExecutionContext) => Promise<PluginExecutionResult>;
  validate?: (input: unknown) => Promise<PluginValidationResult>;
  schema?: {
    input: unknown;
    output: unknown;
  };
}

export interface PluginCapability {
  type: 'tool' | 'middleware' | 'transformer' | 'validator';
  operations: string[];
  metadata?: Record<string, unknown>;
}

export interface PluginExecutionContext {
  sessionId: string;
  toolCallId: string;
  userId?: string;
  permissions: string[];
  metadata: Record<string, unknown>;
}

export interface PluginExecutionResult {
  success: boolean;
  output: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  duration?: number;
}

export interface PluginValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  dependencies?: Record<string, string>;
  capabilities: PluginCapability[];
  metadata?: Record<string, unknown>;
}

export interface PluginInstance {
  manifest: PluginManifest;
  tools: PluginTool[];
  middleware?: PluginMiddleware[];
  state: 'loaded' | 'active' | 'error' | 'disabled';
  error?: string;
  loadedAt: number;
  metadata: Record<string, unknown>;
}

export interface PluginMiddleware {
  name: string;
  priority: number;
  intercept: (context: PluginExecutionContext, next: () => Promise<PluginExecutionResult>) => Promise<PluginExecutionResult>;
}

/**
 * Manages plugin lifecycle, loading, and execution
 */
export class PluginManager {
  private plugins: Map<string, PluginInstance> = new Map();
  private pluginDirectories: string[] = [];
  private pluginMiddleware: PluginMiddleware[] = [];
  private readonly eventEmitter: EventEmitter;
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger('PluginManager');
    this.eventEmitter = new EventEmitter();
    this.setupEventHandlers();
  }

  /**
   * Initializes the plugin system
   */
  async initializePluginSystem(): Promise<void> {
    // Set up default plugin directories
    this.pluginDirectories = [
      path.join(process.cwd(), 'plugins'),
      path.join(process.cwd(), '.acp-plugins'),
      path.join(os.homedir(), '.acp-plugins')
    ];

    // Ensure plugin directories exist
    this.pluginDirectories.forEach(dir => {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      } catch (error) {
        this.logger.warn(`Failed to create plugin directory ${dir}: ${error}`);
      }
    });

    // Load plugins from all directories
    for (const dir of this.pluginDirectories) {
      await this.discoverAndLoadPlugins(dir);
    }

    this.logger.info(`Plugin system initialized with ${this.plugins.size} plugins loaded`);
  }

  /**
   * Discovers and loads plugins from a directory
   */
  private async discoverAndLoadPlugins(directory: string): Promise<void> {
    try {
      if (!fs.existsSync(directory)) {
        return;
      }

      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginPath = path.join(directory, entry.name);
          this.loadPlugin(pluginPath);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
          // Direct plugin file
          const pluginPath = path.join(directory, entry.name);
          await this.loadPluginFile(pluginPath);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to discover plugins in ${directory}: ${error}`);
    }
  }

  /**
   * Loads a plugin from a directory
   */
  private loadPlugin(pluginPath: string): void {
    try {
      const manifestPath = path.join(pluginPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return; // Not a valid plugin directory
      }

      const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const mainPath = path.join(pluginPath, manifest.main);

      if (!fs.existsSync(mainPath)) {
        this.logger.warn(`Plugin ${manifest.name}: main file ${manifest.main} not found`);
        return;
      }

      this.loadPluginFile(mainPath, manifest);
    } catch (error) {
      this.logger.warn(`Failed to load plugin from ${pluginPath}: ${error}`);
    }
  }

  /**
   * Loads a plugin from a file
   */
  private async loadPluginFile(filePath: string, manifest?: PluginManifest): Promise<void> {
    try {
      // Use dynamic import for ES6 modules
      const pluginModule = await import(filePath);

      if (!pluginModule || typeof pluginModule !== 'object') {
        this.logger.warn(`Plugin file ${filePath} does not export a valid plugin`);
        return;
      }

      const pluginName = manifest?.name || path.basename(filePath, path.extname(filePath));
      const pluginInstance: PluginInstance = {
        manifest: manifest || {
          name: pluginName,
          version: pluginModule.version || '1.0.0',
          description: pluginModule.description || 'Custom plugin',
          author: pluginModule.author || 'Unknown',
          main: path.basename(filePath),
          capabilities: pluginModule.capabilities || []
        },
        tools: pluginModule.tools || [],
        middleware: pluginModule.middleware || [],
        state: 'loaded',
        loadedAt: Date.now(),
        metadata: pluginModule.metadata || {}
      };

      this.plugins.set(pluginName, pluginInstance);
      this.logger.info(`Loaded plugin: ${pluginName} v${pluginInstance.manifest.version}`);

      // Register middleware
      if (pluginInstance.middleware) {
        pluginInstance.middleware.forEach(middleware => {
          this.pluginMiddleware.push(middleware);
          this.pluginMiddleware.sort((a, b) => a.priority - b.priority);
        });
      }

      // Emit plugin loaded event
      this.eventEmitter.emit('pluginLoaded', pluginInstance);

    } catch (error) {
      this.logger.warn(`Failed to load plugin file ${filePath}: ${error}`);
    }
  }

  /**
   * Executes a plugin tool
   */
  async executePluginTool(
    pluginName: string,
    toolName: string,
    input: unknown,
    context: PluginExecutionContext
  ): Promise<PluginExecutionResult> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin || plugin.state !== 'active') {
      return {
        success: false,
        output: null,
        error: `Plugin ${pluginName} not found or not active`
      };
    }

    const tool = plugin.tools.find(t => t.name === toolName);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `Tool ${toolName} not found in plugin ${pluginName}`
      };
    }

    try {
      // Validate input if validator exists
      if (tool.validate) {
        const validationResult = await tool.validate(input);
        if (!validationResult.valid) {
          return {
            success: false,
            output: null,
            error: `Validation failed: ${validationResult.errors?.join(', ')}`
          };
        }
      }

      // Execute through middleware chain
      const result = await this.executeThroughMiddleware(tool, input, context);

      // Update plugin metrics
      plugin.metadata.lastExecution = Date.now();
      plugin.metadata.executionCount = ((plugin.metadata.executionCount as number) || 0) + 1;

      return result;
    } catch (error) {
      this.logger.error(`Plugin tool execution failed: ${pluginName}.${toolName}`, error);
      return {
        success: false,
        output: null,
        error: `Execution failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Executes a tool through the middleware chain
   */
  private async executeThroughMiddleware(
    tool: PluginTool,
    input: unknown,
    context: PluginExecutionContext
  ): Promise<PluginExecutionResult> {
    let index = 0;

    const next = async (): Promise<PluginExecutionResult> => {
      if (index < this.pluginMiddleware.length) {
        const middleware = this.pluginMiddleware[index++];
        return middleware.intercept(context, next);
      } else {
        // Execute the actual tool
        const startTime = Date.now();
        const result = await tool.execute(input, context);
        result.duration = Date.now() - startTime;
        return result;
      }
    };

    return next();
  }

  /**
   * Lists all available plugins
   */
  getAvailablePlugins(): Array<{ name: string; description: string; version: string; tools: string[] }> {
    return Array.from(this.plugins.values())
      .filter(plugin => plugin.state === 'active')
      .map(plugin => ({
        name: plugin.manifest.name,
        description: plugin.manifest.description,
        version: plugin.manifest.version,
        tools: plugin.tools.map(tool => tool.name)
      }));
  }

  /**
   * Enables a plugin
   */
  enablePlugin(pluginName: string): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return false;
    }

    plugin.state = 'active';
    this.eventEmitter.emit('pluginEnabled', plugin);
    this.logger.info(`Enabled plugin: ${pluginName}`);
    return true;
  }

  /**
   * Disables a plugin
   */
  disablePlugin(pluginName: string): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return false;
    }

    plugin.state = 'disabled';
    this.eventEmitter.emit('pluginDisabled', plugin);
    this.logger.info(`Disabled plugin: ${pluginName}`);
    return true;
  }

  /**
   * Gets plugin information
   */
  getPluginInfo(pluginName: string): PluginInstance | null {
    return this.plugins.get(pluginName) || null;
  }

  /**
   * Handles plugin tool output
   */
  async handlePluginToolOutput(
    sessionId: string,
    msg: Record<string, unknown>,
    pluginName: string,
    toolName: string,
    streamingOperationId?: string,
    completeStreamingOperation?: (id: string, success: boolean) => void,
    sendSessionUpdate?: (update: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const toolCallId = typeof msg.id === 'string' ? msg.id : String(msg.id || "");

    try {
      // Execute plugin tool
      const pluginContext: PluginExecutionContext = {
        sessionId,
        toolCallId,
        permissions: [], // TODO: Implement permission system
        metadata: {
          timestamp: Date.now()
        }
      };

      const result = await this.executePluginTool(pluginName, toolName, msg.input, pluginContext);

      // Format plugin tool output
      const enhancedContent = this.formatPluginToolOutput(result, pluginName, toolName);

      // Send agent thought for plugin completion
      // TODO: Implement sendAgentThought

      // Complete streaming operation
      if (streamingOperationId && completeStreamingOperation) {
        completeStreamingOperation(streamingOperationId, result.success);
      }

      if (sendSessionUpdate) {
        await sendSessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: result.success ? "completed" : "failed",
            content: [{
              type: "content",
              content: {
                type: "text",
                text: enhancedContent
              }
            }]
          }
        });
      }

    } catch (error) {
      this.logger.error(`Plugin tool execution failed: ${pluginName}.${toolName}`, error);

      if (sendSessionUpdate) {
        await sendSessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [{
              type: "content",
              content: {
                type: "text",
                text: `[PLUGIN-ERROR] ${pluginName}.${toolName}: ${error instanceof Error ? error.message : String(error)}`
              }
            }]
          }
        });
      }
    }
  }

  /**
   * Formats plugin tool output for display
   */
  private formatPluginToolOutput(result: PluginExecutionResult, pluginName: string, toolName: string): string {
    const status = result.success ? '[PLUGIN-SUCCESS]' : '[PLUGIN-ERROR]';
    const duration = result.duration ? ` (${result.duration}ms)` : '';

    let output = `${status} ${pluginName}.${toolName}${duration}\n`;

    if (result.success) {
      if (typeof result.output === 'string') {
        output += result.output;
      } else if (result.output) {
        output += JSON.stringify(result.output, null, 2);
      }
    } else {
      output += `Error: ${result.error || 'Unknown error'}`;
    }

    // Add metadata if available
    if (result.metadata) {
      const metadataStr = Object.entries(result.metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      if (metadataStr) {
        output += `\n[METADATA] ${metadataStr}`;
      }
    }

    return output;
  }

  /**
   * Sets up event handlers for plugin lifecycle
   */
  private setupEventHandlers(): void {
    this.eventEmitter.on('pluginLoaded', (plugin: PluginInstance) => {
      this.logger.info(`Plugin event: ${plugin.manifest.name} loaded`);
    });

    this.eventEmitter.on('pluginEnabled', (plugin: PluginInstance) => {
      this.logger.info(`Plugin event: ${plugin.manifest.name} enabled`);
    });

    this.eventEmitter.on('pluginDisabled', (plugin: PluginInstance) => {
      this.logger.info(`Plugin event: ${plugin.manifest.name} disabled`);
    });
  }

  /**
   * Gets the event emitter for external event handling
   */
  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  /**
   * Cleans up plugin resources
   */
  cleanup(): void {
    this.plugins.clear();
    this.pluginMiddleware.length = 0;
    this.eventEmitter.removeAllListeners();
    this.logger.info('Plugin manager cleaned up');
  }
}
