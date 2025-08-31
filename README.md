# ACP-Claude-Code Bridge

[![npm version](https://img.shields.io/npm/v/@mrtkrcm/acp-claude-code.svg)](https://www.npmjs.com/package/@mrtkrcm/acp-claude-code)
[![Node.js Version](https://img.shields.io/node/v/@mrtkrcm/acp-claude-code.svg)](https://nodejs.org)

**Connect Claude Code to Zed editor via the Agent Client Protocol (ACP)**

## Quick Start

### 1. Setup
```bash
# Check system compatibility & get Zed configuration
npx @mrtkrcm/acp-claude-code --setup

# Test connection
npx @mrtkrcm/acp-claude-code --test
```

### 2. Authenticate Claude Code
```bash
claude setup-token
```

### 3. Add to Zed settings.json
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["@mrtkrcm/acp-claude-code"],
      "env": { "ACP_PERMISSION_MODE": "acceptEdits" }
    }
  }
}
```

## Features

- **Complete ACP Support** - Full protocol implementation with streaming & batching
- **Smart Permissions** - Auto-accept edits, ask for dangerous operations
- **Session Persistence** - Resume conversations across Zed restarts  
- **Context Management** - 200K token window with intelligent monitoring
- **Enhanced UX** - Setup wizard, connection testing, comprehensive diagnostics
- **Production Ready** - 91/91 tests passing, robust error handling

## Configuration

### Permission Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `default` | Ask for every operation | Maximum safety |
| `acceptEdits` | Auto-accept file edits | Recommended workflow |  
| `bypassPermissions` | Allow all operations | Trusted environments |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ACP_PERMISSION_MODE` | `default` | Permission behavior |
| `ACP_MAX_TURNS` | `100` | Session limit (0 = unlimited) |
| `ACP_DEBUG` | `false` | Enable debug logging |

### Runtime Permission Switching

Change permissions mid-conversation with markers:
```
[ACP:PERMISSION:ACCEPT_EDITS]
Please refactor the authentication module
```

## Troubleshooting

### Common Commands
```bash
# System diagnostics
npx @mrtkrcm/acp-claude-code --diagnose

# Permission help
npx @mrtkrcm/acp-claude-code --reset-permissions

# Debug mode
ACP_DEBUG=true npx @mrtkrcm/acp-claude-code
```

### Common Issues

**Authentication Error**
```bash
claude setup-token
```

**Non-TTY Environment**
```json
{ "env": { "ACP_PERMISSION_MODE": "acceptEdits" } }
```

**Custom Claude Path**
```json
{ "env": { "ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE": "/path/to/claude" } }
```

## Advanced Configuration

### Complete Zed Configuration
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx", 
      "args": ["@mrtkrcm/acp-claude-code"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits",
        "ACP_MAX_TURNS": "0",
        "ACP_DEBUG": "false"
      }
    }
  }
}
```

### Using pnpm
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "pnpx",
      "args": ["@mrtkrcm/acp-claude-code"]
    }
  }
}
```

## Development

### Build from Source
```bash
git clone https://github.com/mrtkrcm/acp-claude-code-bridge.git
cd acp-claude-code-bridge
pnpm install && pnpm run build
```

### Commands
```bash
pnpm run dev        # Hot reload development
pnpm run test       # Run test suite  
pnpm run lint       # Code linting
pnpm run diagnose   # System diagnostics
```

## Architecture

```
Zed Editor ←→ ACP Protocol ←→ Bridge ←→ Claude SDK ←→ Claude API
```

**Key Components:**
- **Session Management** - Persistent contexts with resume capability
- **Message Translation** - ACP ↔ Claude SDK format conversion  
- **Tool Integration** - Streaming execution with rich metadata
- **Permission System** - Granular control with client detection
- **Error Recovery** - Auto-retry with graceful degradation

## Key Environment Variables Reference

| Variable | Default | Purpose | Example |
|----------|---------|---------|---------|
| `ACP_PERMISSION_MODE` | `default` | Controls permission behavior | `acceptEdits` |
| `ACP_MAX_TURNS` | `100` | Session turn limit (0=unlimited) | `0` |
| `ACP_DEBUG` | `false` | Enable debug logging | `true` |
| `ACP_LOG_FILE` | none | Log to file | `/tmp/acp.log` |
| `ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE` | auto-detect | Custom Claude path | `/usr/local/bin/claude` |

## Session Management

- **Automatic Persistence** - Sessions survive Zed restarts
- **Context Tracking** - 200K token window with warnings at 80%/95%
- **Smart Cleanup** - Old sessions auto-deleted after 7 days
- **Resume Support** - Conversations continue seamlessly

## License

MIT

## Credits

Originally inspired by [Xuanwo's](https://github.com/xuanwo) foundational work. This project extends that vision with production-ready features, comprehensive testing, and enhanced UX for the ACP-Claude-Code bridge ecosystem.

---

**Need Help?** Run `npx @mrtkrcm/acp-claude-code --setup` for guided configuration.