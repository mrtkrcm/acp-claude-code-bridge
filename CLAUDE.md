# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an ACP (Agent Client Protocol) bridge that enables Claude Code to work with Zed editor and other ACP-compatible clients. It wraps the Claude Code SDK to provide ACP protocol compatibility with production-ready features including session persistence, context monitoring, and comprehensive error handling.

## Build and Development Commands

- `pnpm run build` - Build the TypeScript project to dist/
- `pnpm run dev` - Run in development mode with hot reload using tsx
- `pnpm run typecheck` - Run TypeScript type checking without emitting files
- `pnpm run lint` - Run ESLint on the src/ directory
- `pnpm run start` - Run the built application from dist/
- `pnpm run diagnose` - Run diagnostics to check system compatibility

### Environment Variables for Development

- `ACP_DEBUG=true` - Enable verbose debug logging
- `ACP_LOG_FILE=/path/to/log` - Log to file for persistent debugging
- `ACP_MAX_TURNS=0` - Set unlimited turns (default: 100)
- `ACP_PERMISSION_MODE=acceptEdits` - Auto-accept file edits for development

## Architecture

The bridge implements the Agent Client Protocol with these core components:

### 1. Agent (src/agent.ts) - Core Logic
The `ClaudeACPAgent` class orchestrates all bridge functionality:
- **Session Management**: Maps ACP session IDs to Claude sessions with persistent resume capability
- **Message Processing**: Converts between ACP and Claude SDK message formats in `handleClaudeMessage()`
- **Advanced Tool System**: Extended tool kind mapping, streaming, batching, and timing metadata
- **Enhanced Content Processing**: Rich diff parsing, resource metadata, and file operation detection  
- **Permission System**: Dynamic tool permissions with granular control and client capability detection
- **Context Monitoring**: Tracks 200k context window usage with warnings and cleanup

### 2. Context Monitor (src/context-monitor.ts) - Resource Management
Prevents context overflow with efficient monitoring:
- Simple token estimation using length/4 ratio
- Automatic warnings at 80% and critical alerts at 95%
- Per-session tracking with cleanup and memory statistics

### 3. Diagnostics (src/diagnostics.ts) - System Health
Comprehensive platform and configuration validation:
- Claude Code executable detection and version checking
- Authentication status verification
- Platform compatibility analysis (TTY, Windows, Node.js version)
- Configuration validation with actionable error messages

### 4. Entry Points
- **src/index.ts** - Main server initialization with stdio transport
- **src/cli.ts** - Command-line interface with diagnostics support

## Key Implementation Details

### Session Management Architecture
The bridge uses a hybrid session approach:
- ACP sessions created with random IDs stored in Map
- Claude sessions obtained after first message via SDK
- Resume functionality maintains conversation context across restarts
- Each session tracks: `pendingPrompt`, `abortController`, `claudeSessionId`, `permissionMode`

### Message Flow Pipeline
1. **ACP Client → Agent**: JSON-RPC messages over stdio
2. **Agent → Claude SDK**: Converted to SDK format with session resume
3. **Claude SDK → Agent**: Streaming SDKMessage responses
4. **Agent → ACP Client**: Converted to ACP SessionNotification updates

### Permission System
Dynamic permission handling supports:
- Runtime mode switching via prompt markers: `[ACP:PERMISSION:ACCEPT_EDITS]`
- Per-session permission overrides
- Client capability detection for direct file operations
- Graceful fallback when permissions denied

### Error Handling Strategy
- Configuration validation on startup with clear error messages
- Graceful degradation when Claude Code unavailable
- Context overflow prevention with user warnings
- Session cleanup and resource management

## Authentication Requirements

Authentication is handled by Claude Code SDK:
```bash
claude setup-token  # Required before first use
```
The bridge automatically uses credentials from `~/.claude/config.json`.

## Package Management

- Use `pnpm` for all operations
- Dependencies use exact versions (no ^ or ~ prefixes)
- ESM module format with Node.js 18+ requirement

## Core Configuration Files

- **package.json** - Project config with ESM and executable setup
- **tsconfig.json** - TypeScript with ES2022 target and strict mode
- **eslint.config.mjs** - Modern ESLint flat config with TypeScript rules
