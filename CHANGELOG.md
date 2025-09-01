## [0.18.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.17.0...v0.18.0) (2025-09-01)

### Features

* **ui**: implement rich tool output formatting with comprehensive shell context
  - Add structured visual headers with box drawing characters and operation icons
  - Include real-time timestamps, user@platform, and working directory information  
  - Display actual commands executed instead of generic "Command executed" messages
  - Show file information including paths, sizes, and line counts in organized headers
  - Enhance read operations with content preview indicators for large files
  - Maintain backward compatibility while providing richer visual feedback

* **execution**: enhance command and file operation visibility
  - Show actual shell commands with proper context and environment details
  - Add comprehensive metadata footers with execution information
  - Include visual separators and structured formatting for better readability
  - Provide file content previews and size information for read operations

### Technical Improvements

* **testing**: update test expectations to match enhanced rich formatting output
* **compatibility**: maintain all existing functionality while adding rich visual enhancements
* **performance**: efficient formatting without impacting operation execution speed

## [0.17.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.16.0...v0.17.0) (2025-09-01)

### Features

* **ui**: enhance tool status indicators and file path display
  - Remove redundant status text from tool indicators (`[PEND]` vs `[PEND] pending`)
  - Show bypass/accept modes only for non-completed events
  - Add full file paths to read/write/edit tool titles for better context
  - Improve visual clarity and reduce noise in tool status display

* **logging**: implement enhanced startup configuration logging
  - Add comprehensive startup configuration display inspired by Gemini CLI
  - Show permission mode and max turns with source attribution
  - Display debug mode, log file, and active feature status
  - Provide transparency for troubleshooting and configuration validation

### Research & Analysis

* **architecture**: comprehensive Gemini CLI research and competitive analysis
  - Analyzed Gemini CLI ACP implementation patterns and best practices
  - Identified learning opportunities and architectural improvements
  - Confirmed our implementation's competitive advantages in stability and UX
  - Applied beneficial transparency patterns while maintaining our quality edge

## [0.16.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.15.0...v0.16.0) (2025-09-01)

### Features

* **indicators**: implement comprehensive Unicode mode indicators for enhanced UX
  - Add `⏸ plan mode` indicator for planning phases
  - Add `⏵⏵ bypass` indicator for bypass permission mode
  - Add `⏵⏵ accept` indicator for auto-accept edit mode
  - Maintain ASCII indicators for tool status and other states
  - Complete bidirectional compatibility between Claude Code and ACP protocols

* **ui**: enhance visual feedback system with hybrid Unicode/ASCII approach
  - Plan entries now display clear mode context in titles
  - Tool execution shows permission context alongside status
  - Comprehensive coverage of all Claude Code and ACP specification modes

### Code Quality

* **cleanup**: remove unused imports and resolve all linting warnings
* **types**: optimize type imports for better maintainability

## [0.11.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.10.0...v0.11.0) (2024-08-31)

### Features

* implement robust session management with race condition prevention ([c166f4d](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/c166f4d))
* comprehensive session management robustness validation ([0955334](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/0955334))

### Bug Fixes

* cleanup: remove temporary files and organize project structure ([128c421](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/128c421))
* cleanup: remove temporary test report from git tracking ([d93e94c](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/d93e94c))

### Performance

* session synchronization with withSessionLock() to prevent race conditions
* conservative session cleanup aligned with Claude Code lifecycle
* memory monitoring and cleanup for 200+ concurrent sessions
* enhanced context monitoring with persistent statistics

## [0.10.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.9.0...v0.10.0) (2024-08-31)

### Features

* improve todo display and fix runtime issues ([62f53d7](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/62f53d7))
* elegant and concise ACP integration improvements ([8e88753](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/8e88753))
* improve UX visibility and remove truncation ([6006311](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/6006311))

### Bug Fixes

* simplify task progress display for Zed compatibility ([a8270e0](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/a8270e0))

### UI/UX

* single-line todo display with pipe separator and icons
* optimized rendering for Zed editor compatibility
* removed truncation to preserve full task visibility

## [0.9.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.8.0...v0.9.0) (2024-08-31)

### Features

* stabilize session management and enhance documentation ([022686d](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/022686d))

### Bug Fixes

* update Claude Code dependency to correct version 1.0.98 ([ff10df0](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/ff10df0))

### Documentation

* comprehensive CLAUDE.md with architecture details
* enhanced README with troubleshooting guides
* session persistence documentation

## [0.8.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.7.0...v0.8.0) (2024-08-31)

### Features

* enhance UX with setup wizard and error recovery ([8baadbc](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/8baadbc))
* fix binary name and enhance task progress display ([d8ad283](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/d8ad283))

### Enhancements

* diagnostic system with compatibility scoring
* enhanced error messages and recovery patterns
* improved task progress visualization

## [0.7.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.6.0...v0.7.0) (2024-08-31)

### Features

* standardize and enhance ACP permission system ([05f1e0a](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/05f1e0a))

### Permissions

* runtime permission mode switching
* granular tool permission configuration
* client capability detection
* enhanced permission request handling

## [0.6.0](https://github.com/mrtkrcm/acp-claude-code-bridge/compare/v0.5.4...v0.6.0) (2024-08-31)

### Features

* rebrand as @mrtkrcm/acp-claude-code scoped package ([f07a304](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/f07a304))
* optimize code quality with centralized logging and DRY patterns ([df41899](https://github.com/mrtkrcm/acp-claude-code-bridge/commit/df41899))

### Infrastructure

* centralized logging system with debug mode support
* code quality improvements with DRY patterns
* package rebranding and scoping

## [0.5.4](https://github.com/xuanwo/acp-claude-code/compare/v0.5.3...v0.5.4) (2025-08-30)

### Bug Fixes

* add support for pathToClaudeCodeExecutable ([#48](https://github.com/xuanwo/acp-claude-code/issues/48)) ([aa68737](https://github.com/xuanwo/acp-claude-code/commit/aa68737d3b65bbabcb8af8807d4302707cd09ccc))

## [0.5.3](https://github.com/xuanwo/acp-claude-code/compare/v0.5.2...v0.5.3) (2025-08-29)

### Bug Fixes

* **agent:** update loadSession return type to Promise<void> for compatibility ([#46](https://github.com/xuanwo/acp-claude-code/issues/46)) ([2486229](https://github.com/xuanwo/acp-claude-code/commit/248622985953ec3813c65ea628dc375ff3e28190))

## [0.5.2](https://github.com/xuanwo/acp-claude-code/compare/v0.5.1...v0.5.2) (2025-08-28)

### Bug Fixes

* Handle tool_use in assistant messages and tool_result in user messages ([#45](https://github.com/xuanwo/acp-claude-code/issues/45)) ([d585e19](https://github.com/xuanwo/acp-claude-code/commit/d585e19516a13e406c4316d3ce4b7ac7d55e133f)), closes [#43](https://github.com/xuanwo/acp-claude-code/issues/43)

## [0.5.1](https://github.com/xuanwo/acp-claude-code/compare/v0.5.0...v0.5.1) (2025-08-28)

### Bug Fixes

* Update package.json entry points to use cli.js ([#32](https://github.com/xuanwo/acp-claude-code/issues/32)) ([6cfb2ba](https://github.com/xuanwo/acp-claude-code/commit/6cfb2ba84fead04a37d9fe0d7e7f062429adad08))

## [0.5.0](https://github.com/xuanwo/acp-claude-code/compare/v0.4.0...v0.5.0) (2025-08-28)

### Features

* Add basic code formatting ([#31](https://github.com/xuanwo/acp-claude-code/issues/31)) ([284c3ca](https://github.com/xuanwo/acp-claude-code/commit/284c3ca73356ffde1c7293dba715ac6d03433ef2))

## [0.4.0](https://github.com/xuanwo/acp-claude-code/compare/v0.3.2...v0.4.0) (2025-08-28)

### Features

- Separate CLI entry point from library exports ([#28](https://github.com/xuanwo/acp-claude-code/issues/28)) ([406a38d](https://github.com/xuanwo/acp-claude-code/commit/406a38d3c56754dd45468247a2d35a9c2e070540))

### Documentation

- Add notes on zed's efforts ([c1c0111](https://github.com/xuanwo/acp-claude-code/commit/c1c0111d0fc65ec972a6e3993c405acf116fb23d))

### Miscellaneous

- Upgrade eslint to v9 ([#27](https://github.com/xuanwo/acp-claude-code/issues/27)) ([250e063](https://github.com/xuanwo/acp-claude-code/commit/250e063c4a04de408d1eafc201631602793f6298))

## [0.3.2](https://github.com/xuanwo/acp-claude-code/compare/v0.3.1...v0.3.2) (2025-08-28)

### Bug Fixes

- Make permission and tool use work in zed ([#26](https://github.com/xuanwo/acp-claude-code/issues/26)) ([8b0b458](https://github.com/xuanwo/acp-claude-code/commit/8b0b45852092c2f7b9af6344011a856ee7f7a6d6))

## [0.3.1](https://github.com/xuanwo/acp-claude-code/compare/v0.3.0...v0.3.1) (2025-08-28)

### Bug Fixes

- Remove not needed checks ([#25](https://github.com/xuanwo/acp-claude-code/issues/25)) ([670631d](https://github.com/xuanwo/acp-claude-code/commit/670631debf8ecbdc33957003add12956dc7aa329))

### CI/CD

- Create github releases but not assets ([686e0c9](https://github.com/xuanwo/acp-claude-code/commit/686e0c9606ab3a5d722dc85d79ea2cd83ae305eb))
- **deps:** Bump actions/checkout from 4 to 5 ([#23](https://github.com/xuanwo/acp-claude-code/issues/23)) ([cd2435f](https://github.com/xuanwo/acp-claude-code/commit/cd2435f2467ca312680590f08638540ae432d32e))

## [0.3.0](https://github.com/xuanwo/acp-claude-code/compare/v0.2.2...v0.3.0) (2025-08-27)

### Features

- Support session resume ([#19](https://github.com/xuanwo/acp-claude-code/issues/19)) ([513ec9d](https://github.com/xuanwo/acp-claude-code/commit/513ec9d719178eaf18184c586529f134d0140070))

### CI/CD

- Don't upload dist to github directly ([64cd37d](https://github.com/xuanwo/acp-claude-code/commit/64cd37df1065e880faff38c778aabbb25127b552))

## [0.2.2](https://github.com/xuanwo/acp-claude-code/compare/v0.2.1...v0.2.2) (2025-08-27)

### Bug Fixes

- Fix npm publish again ([#12](https://github.com/xuanwo/acp-claude-code/issues/12)) ([d31b45d](https://github.com/xuanwo/acp-claude-code/commit/d31b45d8bad7be0f602492e726f768157f108abc))
- tool_use not generated correctly ([#14](https://github.com/xuanwo/acp-claude-code/issues/14)) ([58d61b2](https://github.com/xuanwo/acp-claude-code/commit/58d61b2e07ba571c631e7fde5c278d91ea861512))

### CI/CD

- Setup semantic release ([#15](https://github.com/xuanwo/acp-claude-code/issues/15)) ([6cc4507](https://github.com/xuanwo/acp-claude-code/commit/6cc450732904d2fb4d96cd5d170ac4385688f104))
- Use NPM_TOKEN for release ([c98d80d](https://github.com/xuanwo/acp-claude-code/commit/c98d80d53b0ee43f774bc0c764c9bb692fc0b54f))

### Miscellaneous

- Fix wrong fields in package.json ([#16](https://github.com/xuanwo/acp-claude-code/issues/16)) ([cc7d28a](https://github.com/xuanwo/acp-claude-code/commit/cc7d28a7320f808e473826af0780ad730999cb97))
- Remove registry-url during setup node ([fcbdae7](https://github.com/xuanwo/acp-claude-code/commit/fcbdae7c5f9099b434e4b8a2cf0c65efe9b8192e))
