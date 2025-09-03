import { z } from 'zod';
import { EOL } from 'node:os';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { WritableStream, ReadableStream } from 'node:stream/web';
import * as schema from './schema.js';

// JSON-RPC message types
type AnyMessage = AnyRequest | AnyResponse | AnyNotification;

type AnyRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
};

type AnyResponse = {
  jsonrpc: '2.0';
  id: string | number;
} & Result<unknown>;

type AnyNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type Result<T> =
  | {
    result: T;
  }
  | {
    error: ErrorResponse;
  };

type ErrorResponse = {
  code: number;
  message: string;
  data?: unknown;
};

type PendingResponse = {
  resolve: (response: unknown) => void;
  reject: (error: ErrorResponse) => void;
};

type MethodHandler = (method: string, params: unknown) => Promise<unknown>;

// Enhanced error handling with specific error codes
export class RequestError extends Error {
  data?: { details?: string };

  constructor(
    public code: number,
    message: string,
    details?: string,
  ) {
    super(message);
    this.name = 'RequestError';
    if (details) {
      this.data = { details };
    }
  }

  static parseError(details?: string): RequestError {
    return new RequestError(-32700, 'Parse error', details);
  }

  static invalidRequest(details?: string): RequestError {
    return new RequestError(-32600, 'Invalid request', details);
  }

  static methodNotFound(method?: string): RequestError {
    return new RequestError(-32601, `Method not found: ${method || 'unknown'}`, method);
  }

  static invalidParams(details?: string): RequestError {
    return new RequestError(-32602, 'Invalid params', details);
  }

  static internalError(details?: string): RequestError {
    return new RequestError(-32603, 'Internal error', details);
  }

  static authRequired(details?: string): RequestError {
    return new RequestError(-32000, 'Authentication required', details);
  }

  static sessionNotFound(sessionId?: string): RequestError {
    return new RequestError(-32001, `Session not found: ${sessionId || 'unknown'}`, sessionId);
  }

  static sessionBusy(sessionId?: string): RequestError {
    return new RequestError(-32002, `Session busy: ${sessionId || 'unknown'}`, sessionId);
  }

  static resourceExhausted(details?: string): RequestError {
    return new RequestError(-32003, 'Resource exhausted', details);
  }

  toResult<T>(): Result<T> {
    return {
      error: {
        code: this.code,
        message: this.message,
        data: this.data,
      },
    };
  }
}

// Robust connection class with proper message queuing and error handling
class Connection {
  #pendingResponses: Map<string | number, PendingResponse> = new Map();
  #nextRequestId: number = 0;
  #handler: MethodHandler;
  #peerInput: WritableStream<Uint8Array>;
  #writeQueue: Promise<void> = Promise.resolve();
  #textEncoder: InstanceType<typeof TextEncoder>;
  #isDestroyed = false;

  constructor(
    handler: MethodHandler,
    peerInput: WritableStream<Uint8Array>,
    peerOutput: ReadableStream<Uint8Array>,
  ) {
    this.#handler = handler;
    this.#peerInput = peerInput;
    this.#textEncoder = new TextEncoder();
    this.#receive(peerOutput);
  }

  async #receive(output: ReadableStream<Uint8Array>) {
    let content = '';
    const decoder = new TextDecoder();

    try {
      for await (const chunk of output) {
        if (this.#isDestroyed) break;

        content += decoder.decode(chunk, { stream: true });
        const lines = content.split(EOL);
        content = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (trimmedLine) {
            try {
              const message = JSON.parse(trimmedLine);
              await this.#processMessage(message);
            } catch (error) {
              // Send parse error response
              await this.#sendParseError(error);
            }
          }
        }
      }
    } catch (error) {
      console.error('ACP connection receive error:', error);
    }
  }

  async #processMessage(message: AnyMessage) {
    try {
      if ('method' in message && 'id' in message) {
        // It's a request - handle with validation
        const response = await this.#tryCallHandler(message.method, message.params);
        await this.#sendMessage({
          jsonrpc: '2.0',
          id: message.id,
          ...response,
        });
      } else if ('method' in message) {
        // It's a notification - no response needed
        await this.#tryCallHandler(message.method, message.params);
      } else if ('id' in message) {
        // It's a response - resolve pending request
        this.#handleResponse(message as AnyResponse);
      }
    } catch (error) {
      console.error('ACP message processing error:', error);
    }
  }

  async #tryCallHandler(method: string, params?: unknown): Promise<Result<unknown>> {
    try {
      const result = await this.#handler(method, params);
      return { result: result ?? null };
    } catch (error: unknown) {
      if (error instanceof RequestError) {
        return error.toResult();
      }

      if (error instanceof z.ZodError) {
        return RequestError.invalidParams(
          JSON.stringify(error.format(), undefined, 2),
        ).toResult();
      }

      let details: string | undefined;
      if (error instanceof Error) {
        details = error.message;
      } else if (
        typeof error === 'object' &&
        error != null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        details = error.message;
      }

      return RequestError.internalError(details).toResult();
    }
  }

  #handleResponse(response: AnyResponse) {
    const pendingResponse = this.#pendingResponses.get(response.id);
    if (pendingResponse) {
      if ('result' in response) {
        pendingResponse.resolve(response.result);
      } else if ('error' in response) {
        pendingResponse.reject(response.error);
      }
      this.#pendingResponses.delete(response.id);
    }
  }

  async #sendParseError(error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await this.#sendMessage({
      jsonrpc: '2.0',
      id: null as any,
      error: {
        code: -32700,
        message: 'Parse error',
        data: errorMessage,
      },
    });
  }

  async sendRequest<Req, Resp>(method: string, params?: Req): Promise<Resp> {
    if (this.#isDestroyed) {
      throw new Error('Connection is destroyed');
    }

    const id = this.#nextRequestId++;
    const responsePromise = new Promise((resolve, reject) => {
      this.#pendingResponses.set(id, { resolve, reject });
    });

    await this.#sendMessage({ jsonrpc: '2.0', id, method, params });
    return responsePromise as Promise<Resp>;
  }

  async sendNotification<N>(method: string, params?: N): Promise<void> {
    if (this.#isDestroyed) {
      return;
    }

    await this.#sendMessage({ jsonrpc: '2.0', method, params });
  }

  async #sendMessage(json: AnyMessage) {
    const content = JSON.stringify(json) + '\n';

    this.#writeQueue = this.#writeQueue
      .then(async () => {
        if (this.#isDestroyed) return;

        const writer = this.#peerInput.getWriter();
        try {
          await writer.write(this.#textEncoder.encode(content));
        } finally {
          writer.releaseLock();
        }
      })
      .catch((error) => {
        console.error('ACP write error:', error);
        // Don't rethrow - continue processing
      });

    return this.#writeQueue;
  }

  destroy() {
    this.#isDestroyed = true;
    // Reject all pending responses
    for (const [id, pending] of this.#pendingResponses) {
      pending.reject({
        code: -32003,
        message: 'Connection destroyed',
        data: { requestId: id },
      });
    }
    this.#pendingResponses.clear();
  }
}

// Enhanced Agent Side Connection with file system operations
export class AgentSideConnection implements Client {
  #connection: Connection;
  #fileSystemEnabled: boolean;

  constructor(
    toAgent: (conn: Client) => Agent,
    input: WritableStream<Uint8Array>,
    output: ReadableStream<Uint8Array>,
    options: { fileSystemEnabled?: boolean } = {},
  ) {
    this.#fileSystemEnabled = options.fileSystemEnabled ?? false;
    const agent = toAgent(this);

    const handler = async (method: string, params: unknown): Promise<unknown> => {
      switch (method) {
        case schema.AGENT_METHODS.initialize: {
          const validatedParams = schema.initializeRequestSchema.parse(params);
          return agent.initialize(validatedParams);
        }
        case schema.AGENT_METHODS.session_new: {
          const validatedParams = schema.newSessionRequestSchema.parse(params);
          return agent.newSession(validatedParams);
        }
        case schema.AGENT_METHODS.session_load: {
          if (!agent.loadSession) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = schema.loadSessionRequestSchema.parse(params);
          return agent.loadSession(validatedParams);
        }
        case schema.AGENT_METHODS.authenticate: {
          const validatedParams = schema.authenticateRequestSchema.parse(params);
          return agent.authenticate(validatedParams);
        }
        case schema.AGENT_METHODS.session_prompt: {
          const validatedParams = schema.promptRequestSchema.parse(params);
          return agent.prompt(validatedParams);
        }
        case schema.AGENT_METHODS.session_cancel: {
          const validatedParams = schema.cancelNotificationSchema.parse(params);
          return agent.cancel(validatedParams);
        }
        // Handle file system operations if enabled
        case schema.CLIENT_METHODS.fs_read_text_file: {
          if (!this.#fileSystemEnabled) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = schema.readTextFileRequestSchema.parse(params);
          return await this.#handleReadTextFile(validatedParams);
        }
        case schema.CLIENT_METHODS.fs_write_text_file: {
          if (!this.#fileSystemEnabled) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = schema.writeTextFileRequestSchema.parse(params);
          return await this.#handleWriteTextFile(validatedParams);
        }
        default:
          throw RequestError.methodNotFound(method);
      }
    };

    this.#connection = new Connection(handler, input, output);
  }

  destroy() {
    this.#connection.destroy();
  }

  // Client interface methods
  async sessionUpdate(params: schema.SessionNotification): Promise<void> {
    return await this.#connection.sendNotification(
      schema.CLIENT_METHODS.session_update,
      params,
    );
  }

  async requestPermission(params: schema.RequestPermissionRequest): Promise<schema.RequestPermissionResponse> {
    return await this.#connection.sendRequest(
      schema.CLIENT_METHODS.session_request_permission,
      params,
    );
  }

  async readTextFile(params: schema.ReadTextFileRequest): Promise<schema.ReadTextFileResponse> {
    return await this.#connection.sendRequest(
      schema.CLIENT_METHODS.fs_read_text_file,
      params,
    );
  }

  async writeTextFile(params: schema.WriteTextFileRequest): Promise<schema.WriteTextFileResponse> {
    return await this.#connection.sendRequest(
      schema.CLIENT_METHODS.fs_write_text_file,
      params,
    );
  }

  // File system operation handlers
  async #handleReadTextFile(params: schema.ReadTextFileRequest): Promise<schema.ReadTextFileResponse> {
    try {
      // Security: Ensure path is within allowed boundaries
      const resolvedPath = path.resolve(params.path);
      const cwd = process.cwd();

      // Prevent reading files outside the current working directory
      if (!resolvedPath.startsWith(cwd)) {
        throw RequestError.internalError('Access denied: file outside workspace');
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');

      // Apply limit if specified
      let processedContent = content;
      if (params.limit !== null && params.limit !== undefined && params.limit > 0) {
        const lines = content.split('\n');
        processedContent = lines.slice(0, params.limit).join('\n');
        if (lines.length > params.limit) {
          processedContent += '\n... (truncated)';
        }
      }

      // Apply line offset if specified
      if (params.line !== null && params.line !== undefined && params.line > 0) {
        const lines = processedContent.split('\n');
        const startLine = Math.max(0, params.line - 1); // Convert to 0-based index
        processedContent = lines.slice(startLine).join('\n');
      }

      return { content: processedContent };
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw RequestError.internalError(`File not found: ${params.path}`);
      }

      throw RequestError.internalError(`Failed to read file: ${(error as Error).message}`);
    }
  }

  async #handleWriteTextFile(params: schema.WriteTextFileRequest): Promise<schema.WriteTextFileResponse> {
    try {
      // Security: Ensure path is within allowed boundaries
      const resolvedPath = path.resolve(params.path);
      const cwd = process.cwd();

      // Prevent writing files outside the current working directory
      if (!resolvedPath.startsWith(cwd)) {
        throw RequestError.internalError('Access denied: file outside workspace');
      }

      // Ensure directory exists
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(resolvedPath, params.content, 'utf-8');
      return null; // Success response
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }

      throw RequestError.internalError(`Failed to write file: ${(error as Error).message}`);
    }
  }
}

// Client interface with file system operations
export interface Client {
  requestPermission(params: schema.RequestPermissionRequest): Promise<schema.RequestPermissionResponse>;
  sessionUpdate(params: schema.SessionNotification): Promise<void>;
  writeTextFile(params: schema.WriteTextFileRequest): Promise<schema.WriteTextFileResponse>;
  readTextFile(params: schema.ReadTextFileRequest): Promise<schema.ReadTextFileResponse>;
}

// Agent interface
export interface Agent {
  initialize(params: schema.InitializeRequest): Promise<schema.InitializeResponse>;
  newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse>;
  loadSession?(params: schema.LoadSessionRequest): Promise<schema.LoadSessionResponse>;
  authenticate(params: schema.AuthenticateRequest): Promise<schema.AuthenticateResponse>;
  prompt(params: schema.PromptRequest): Promise<schema.PromptResponse>;
  cancel(params: schema.CancelNotification): Promise<void>;
}
