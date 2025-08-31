# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.5.x   | :white_check_mark: |
| < 0.5   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in this ACP-Claude-Code bridge, please report it responsibly:

1. **Do not** create a public GitHub issue for security vulnerabilities
2. Email security details to: karacamjr@gmail.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Any suggested fixes

## Security Considerations

This bridge:
- Uses Claude Code SDK authentication (stored in ~/.claude/config.json)
- Does not store or transmit API keys directly
- Operates with configurable permission modes for file operations
- Logs debug information when ACP_DEBUG=true (may contain sensitive paths)

## Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 1 week  
- **Resolution Target**: Within 2 weeks for critical issues

Thank you for helping keep this project secure.