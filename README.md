# ACP-Claude-Code Bridge

A robust Agent Client Protocol (ACP) bridge that enables Claude Code to work seamlessly with Zed editor and other ACP-compatible clients.

## 🚀 Features

- **Full ACP Protocol Support**: Complete implementation of the Agent Client Protocol
- **Configurable Turn Limits**: Set custom turn limits or enable unlimited sessions (0 = unlimited)
- **Context Monitoring**: Smart 200k context window management with graceful warnings
- **Session Persistence**: Resume conversations across restarts
- **Comprehensive Logging**: Debug-friendly logging with file output support
- **Robust Error Handling**: Graceful degradation and clear error messages
- **Multiple Permission Modes**: Support for different interaction patterns

## Architecture

This project implements an ACP Agent that wraps the Claude Code SDK, providing:

- **Session persistence**: Maintains conversation context across multiple messages
- **Streaming responses**: Real-time output from Claude
- **Tool call support**: Full integration with Claude's tool use capabilities (TODO)
- **Message format conversion**: Seamless translation between ACP and Claude SDK formats

## Usage in Zed

Add to your Zed settings.json:

### Basic Configuration

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["acp-claude-code"]
    }
  }
}
```

### With Permission Mode Configuration

To auto-accept file edits (recommended for better workflow):

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["acp-claude-code"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits"
      }
    }
  }
}
```

To bypass all permissions (use with caution):

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["acp-claude-code"],
      "env": {
        "ACP_PERMISSION_MODE": "bypassPermissions"
      }
    }
  }
}
```

### With Debug Logging

For troubleshooting:

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["acp-claude-code"],
      "env": {
        "ACP_DEBUG": "true",
        "ACP_PERMISSION_MODE": "acceptEdits"
      }
    }
  }
}
```

### With Custom Claude Code Executable Path

If you need to use a specific Claude Code executable (e.g., development build):

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["acp-claude-code"],
      "env": {
        "ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE": "/path/to/your/claude-code",
        "ACP_PERMISSION_MODE": "acceptEdits"
      }
    }
  }
}
```

### Using pnpm/pnpx

If you prefer pnpm:

```json
{
  "agent_servers": {
    "claude-code": {
      "command": "pnpx",
      "args": ["acp-claude-code"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits"
      }
    }
  }
}
```

## Development

### Building from source

If you want to build and run from source instead of using the npm package:

```bash
# Clone the repository
git clone https://github.com/xuanwo/acp-claude-code.git
cd acp-claude-code

# Install dependencies
pnpm install

# Build the project
pnpm run build

# Run directly
node dist/index.js
```

For development with hot reload:

```bash
# Run in development mode
pnpm run dev

# Type checking
pnpm run typecheck

# Build
pnpm run build

# Lint checking
pnpm run lint
```

## Features

### Implemented

- ✅ Full ACP protocol implementation
- ✅ Session persistence with Claude's native session management
- ✅ Streaming responses
- ✅ Text content blocks
- ✅ Claude SDK integration
- ✅ Tool call support with proper status updates
- ✅ Session loading capability
- ✅ Permission management with configurable modes
- ✅ Rich content display (todo lists, tool usage)

### Planned

- [ ] Image/audio content blocks
- [ ] Advanced error handling
- [ ] Session export/import

## Authentication

This bridge uses Claude Code's built-in authentication. You need to authenticate Claude Code first:

```bash
# Login with your Anthropic account
claude setup-token

# Or if you're already logged in through the Claude Code CLI, it will use that session
```

The bridge will automatically use the existing Claude Code authentication from `~/.claude/config.json`.

## Permission Modes

The bridge supports different permission modes for Claude's file operations:

### Available Modes

- **`default`** - Asks for permission on file operations (default)
- **`acceptEdits`** - Auto-accepts file edits, still asks for other operations (recommended)
- **`bypassPermissions`** - Bypasses all permission checks (use with caution!)

### Configuration in Zed

Set the permission mode in your Zed settings.json using the `env` field as shown in the usage examples above.

### Dynamic Permission Mode Switching

You can also change permission mode during a conversation by including special markers in your prompt:

- `[ACP:PERMISSION:ACCEPT_EDITS]` - Switch to acceptEdits mode
- `[ACP:PERMISSION:BYPASS]` - Switch to bypassPermissions mode
- `[ACP:PERMISSION:DEFAULT]` - Switch back to default mode

Example:

```
[ACP:PERMISSION:ACCEPT_EDITS]
Please update all the TypeScript files to use the new API
```

## Environment Variables

### Core Settings

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `ACP_MAX_TURNS` | Maximum turns per session (0 = unlimited) | `100` | `1000` |
| `ACP_PERMISSION_MODE` | Default permission mode | `default` | `acceptEdits` |
| `ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE` | Path to Claude Code executable | auto-detect | `/usr/local/bin/claude` |

### Debugging & Logging

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `ACP_DEBUG` | Enable debug logging | `false` | `true` |
| `ACP_LOG_FILE` | File path for persistent logs | none | `/tmp/acp-bridge.log` |

**NEW: Unlimited Sessions**
Set `ACP_MAX_TURNS=0` for unlimited turns - no session interruption!

## Debugging

Debug logging can be enabled in your Zed configuration (see usage examples above) or when running manually:

```bash
# Set the debug environment variable
ACP_DEBUG=true npx acp-claude-code
```

Debug logs will output:

- Session creation and management
- Message processing
- Tool call execution
- Claude SDK interactions

## Troubleshooting

### Session not persisting

The bridge now correctly maintains session context using Claude's native session management. Each ACP session maps to a Claude session that persists throughout the conversation.

### "Claude Code process exited" error

Make sure you're authenticated with Claude Code:

```bash
claude setup-token
```

### Tool calls not working

Tool calls are fully supported. Ensure your Zed client is configured to handle tool call updates properly.

## Technical Details

### Session Management

The bridge uses a two-step session management approach:

1. Creates an ACP session ID initially
2. On first message, obtains and stores Claude's session ID
3. Uses Claude's `resume` parameter for subsequent messages to maintain context

### Message Flow

1. **Client → Agent**: ACP protocol messages
2. **Agent → Claude SDK**: Converted to Claude SDK format with session resume
3. **Claude SDK → Agent**: Stream of response messages
4. **Agent → Client**: Converted back to ACP protocol format

## License

MIT
