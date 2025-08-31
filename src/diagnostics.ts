import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface PlatformCapabilities {
  platform: NodeJS.Platform;
  hasTTY: boolean;
  terminal: string | undefined;
  isWSL: boolean;
  nodeVersion: string;
  arch: string;
}

export interface DiagnosticIssue {
  level: 'error' | 'warning' | 'info';
  category: 'platform' | 'configuration' | 'claude' | 'permissions';
  message: string;
  solution?: string;
  code?: string;
}

export interface DiagnosticReport {
  platform: PlatformCapabilities;
  claudeCode: {
    available: boolean;
    path?: string;
    version?: string;
    authenticated?: boolean;
  };
  configuration: {
    permissionMode: string;
    pathOverride?: string;
    debugMode: boolean;
  };
  issues: DiagnosticIssue[];
  compatible: boolean;
  score: number; // 0-100 compatibility score
}

export class DiagnosticSystem {
  static detectPlatformCapabilities(): PlatformCapabilities {
    return {
      platform: process.platform,
      hasTTY: process.stdout.isTTY || false,
      terminal: process.env.TERM,
      isWSL: !!process.env.WSL_DISTRO_NAME,
      nodeVersion: process.version,
      arch: process.arch,
    };
  }

  static async findClaudeExecutable(pathOverride?: string): Promise<string | null> {
    const candidates = [
      pathOverride,
      process.env.ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE,
      '/usr/local/bin/claude',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', 
      '/opt/homebrew/bin/claude',
      '~/.local/bin/claude',
      // Additional common installation paths
      '~/.npm-global/bin/claude',
      '/usr/bin/claude',
      process.env.HOME ? `${process.env.HOME}/.local/share/pnpm/global/5/node_modules/.bin/claude` : null,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        // Resolve ~ to home directory
        const resolvedPath = candidate.startsWith('~') 
          ? resolve(process.env.HOME || '/', candidate.slice(2))
          : candidate;

        await access(resolvedPath, constants.F_OK | constants.X_OK);
        return resolvedPath;
      } catch {
        continue;
      }
    }

    // Try 'claude' in PATH with enhanced detection
    return new Promise((resolve) => {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const child = spawn(whichCmd, ['claude'], { 
        stdio: 'pipe',
        timeout: 5000  // 5 second timeout
      });
      let output = '';
      
      child.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      child.on('close', (code) => {
        if (code === 0 && output.trim()) {
          const path = output.trim().split('\n')[0]; // First result on Windows 'where'
          resolve(path);
        } else {
          resolve(null);
        }
      });
      
      child.on('error', (err) => {
        console.warn(`Path detection failed: ${err.message}`);
        resolve(null);
      });
    });
  }

  static async getClaudeVersion(executablePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(executablePath, ['--version'], { stdio: 'pipe' });
      let output = '';
      
      child.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          // Extract version from output like "1.0.98 (Claude Code)"
          const match = output.match(/(\d+\.\d+\.\d+)/);
          resolve(match ? match[1] : output.trim());
        } else {
          resolve(null);
        }
      });
      
      child.on('error', () => resolve(null));
    });
  }

  static async checkClaudeAuthentication(_executablePath: string): Promise<boolean> {
    // Check if config file exists
    const configPath = resolve(process.env.HOME || '/', '.claude', 'config.json');
    return existsSync(configPath);
  }

  static async generateReport(): Promise<DiagnosticReport> {
    const platform = this.detectPlatformCapabilities();
    const issues: DiagnosticIssue[] = [];
    
    // Configuration analysis
    const permissionMode = process.env.ACP_PERMISSION_MODE || 'default';
    const pathOverride = process.env.ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE;
    const debugMode = process.env.ACP_DEBUG === 'true';

    // Platform compatibility checks
    if (!platform.hasTTY) {
      issues.push({
        level: 'warning',
        category: 'platform',
        code: 'NO_TTY',
        message: 'Running in non-TTY environment',
        solution: 'Some Claude Code features may be limited. Consider using acceptEdits permission mode.'
      });
    }

    if (platform.platform === 'win32') {
      issues.push({
        level: 'warning',
        category: 'platform', 
        code: 'WINDOWS_PLATFORM',
        message: 'Windows platform detected',
        solution: 'Consider using WSL or PowerShell instead of Git Bash for better compatibility.'
      });
    }

    // Enhanced Node.js version check
    const nodeVersionMatch = platform.nodeVersion.match(/^v(\d+)\.(\d+)\.(\d+)/);
    if (nodeVersionMatch) {
      const [, major, minor] = nodeVersionMatch;
      const majorVersion = parseInt(major, 10);
      const minorVersion = parseInt(minor, 10);
      
      if (majorVersion < 18) {
        issues.push({
          level: 'error',
          category: 'platform',
          code: 'NODE_VERSION_OLD',
          message: `Node.js ${platform.nodeVersion} is too old (minimum: 18.0.0)`,
          solution: 'Upgrade to Node.js 18 or later using nvm, n, or download from nodejs.org'
        });
      } else if (majorVersion === 18 && minorVersion < 12) {
        issues.push({
          level: 'warning',
          category: 'platform',
          code: 'NODE_VERSION_OUTDATED',
          message: `Node.js ${platform.nodeVersion} is outdated (recommended: 18.12+)`,
          solution: 'Consider upgrading to a more recent Node.js LTS version'
        });
      }
    } else {
      issues.push({
        level: 'warning',
        category: 'platform',
        code: 'NODE_VERSION_UNKNOWN',
        message: `Cannot parse Node.js version: ${platform.nodeVersion}`,
        solution: 'Verify Node.js installation'
      });
    }

    // Claude Code analysis
    const claudePath = await this.findClaudeExecutable(pathOverride);
    const claudeAvailable = !!claudePath;
    let claudeVersion: string | undefined;
    let claudeAuthenticated: boolean | undefined;

    if (claudeAvailable && claudePath) {
      claudeVersion = await this.getClaudeVersion(claudePath) || undefined;
      claudeAuthenticated = await this.checkClaudeAuthentication(claudePath);

      if (!claudeVersion) {
        issues.push({
          level: 'warning',
          category: 'claude',
          code: 'VERSION_CHECK_FAILED',
          message: 'Could not determine Claude Code version',
          solution: 'Verify Claude Code installation is working properly.'
        });
      }

      if (!claudeAuthenticated) {
        issues.push({
          level: 'error',
          category: 'claude',
          code: 'NOT_AUTHENTICATED',
          message: 'Claude Code is not authenticated',
          solution: 'Run "claude setup-token" to authenticate.'
        });
      }
    } else {
      issues.push({
        level: 'error',
        category: 'claude',
        code: 'EXECUTABLE_NOT_FOUND',
        message: 'Claude Code executable not found',
        solution: pathOverride 
          ? `Check if the path ${pathOverride} exists and is executable.`
          : 'Install Claude Code or set ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE environment variable.'
      });
    }

    // Configuration recommendations
    if (!platform.hasTTY && permissionMode === 'default') {
      issues.push({
        level: 'info',
        category: 'configuration',
        code: 'PERMISSION_MODE_SUGGESTION',
        message: 'Consider using acceptEdits permission mode for non-TTY environments',
        solution: 'Set ACP_PERMISSION_MODE=acceptEdits environment variable.'
      });
    }

    // Enhanced path validation
    if (pathOverride) {
      if (!existsSync(pathOverride)) {
        issues.push({
          level: 'error',
          category: 'configuration',
          code: 'CUSTOM_PATH_NOT_FOUND',
          message: `Custom Claude Code path does not exist: ${pathOverride}`,
          solution: 'Verify the ACP_PATH_TO_CLAUDE_CODE_EXECUTABLE path is correct and accessible.'
        });
      } else {
        // Check if path is executable
        try {
          await access(pathOverride, constants.X_OK);
        } catch {
          issues.push({
            level: 'error',
            category: 'configuration',
            code: 'CUSTOM_PATH_NOT_EXECUTABLE',
            message: `Custom Claude Code path is not executable: ${pathOverride}`,
            solution: 'Make the file executable with: chmod +x <path>'
          });
        }
      }
    }

    // Enhanced compatibility scoring
    const errorCount = issues.filter(i => i.level === 'error').length;
    const warningCount = issues.filter(i => i.level === 'warning').length;
    const infoCount = issues.filter(i => i.level === 'info').length;
    
    let score = 100;
    score -= errorCount * 30; // Errors are serious
    score -= warningCount * 10; // Warnings are less serious  
    score -= infoCount * 2; // Info items are minor
    
    // Bonus points for good configurations
    if (claudeAvailable && claudeAuthenticated) score += 5;
    if (platform.hasTTY) score += 2;
    if (permissionMode !== 'default') score += 3; // Explicit permission mode is good
    
    score = Math.max(0, Math.min(100, score)); // Clamp between 0-100

    const compatible = errorCount === 0;

    return {
      platform,
      claudeCode: {
        available: claudeAvailable,
        path: claudePath || undefined,
        version: claudeVersion,
        authenticated: claudeAuthenticated,
      },
      configuration: {
        permissionMode,
        pathOverride,
        debugMode,
      },
      issues,
      compatible,
      score,
    };
  }

  static formatReport(report: DiagnosticReport): string {
    const { platform, claudeCode, configuration, issues, compatible, score } = report;
    
    let output = '🔍 ACP-Claude-Code Diagnostic Report\n';
    output += '=' .repeat(50) + '\n\n';
    
    // Overall status
    const statusEmoji = compatible ? '✅' : '❌';
    output += `${statusEmoji} Overall Status: ${compatible ? 'COMPATIBLE' : 'ISSUES FOUND'}\n`;
    output += `📊 Compatibility Score: ${score}/100\n\n`;
    
    // Platform info
    output += '🖥️ Platform Information:\n';
    output += `   Platform: ${platform.platform} (${platform.arch})\n`;
    output += `   Node.js: ${platform.nodeVersion}\n`;
    output += `   TTY Support: ${platform.hasTTY ? 'Yes' : 'No'}\n`;
    output += `   Terminal: ${platform.terminal || 'Unknown'}\n`;
    if (platform.isWSL) output += `   WSL Environment: Yes\n`;
    output += '\n';
    
    // Claude Code status
    output += '🤖 Claude Code Status:\n';
    output += `   Available: ${claudeCode.available ? 'Yes' : 'No'}\n`;
    if (claudeCode.path) output += `   Path: ${claudeCode.path}\n`;
    if (claudeCode.version) output += `   Version: ${claudeCode.version}\n`;
    if (claudeCode.authenticated !== undefined) {
      output += `   Authenticated: ${claudeCode.authenticated ? 'Yes' : 'No'}\n`;
    }
    output += '\n';
    
    // Configuration
    output += '⚙️ Configuration:\n';
    output += `   Permission Mode: ${configuration.permissionMode}\n`;
    output += `   Debug Mode: ${configuration.debugMode ? 'Enabled' : 'Disabled'}\n`;
    if (configuration.pathOverride) {
      output += `   Custom Path: ${configuration.pathOverride}\n`;
    }
    output += '\n';
    
    // Issues
    if (issues.length > 0) {
      output += '⚠️ Issues Found:\n\n';
      
      const errors = issues.filter(i => i.level === 'error');
      const warnings = issues.filter(i => i.level === 'warning');  
      const infos = issues.filter(i => i.level === 'info');
      
      if (errors.length > 0) {
        output += '🚨 ERRORS (Must Fix):\n';
        errors.forEach((issue, i) => {
          output += `   ${i + 1}. ${issue.message}\n`;
          if (issue.solution) output += `      → ${issue.solution}\n`;
        });
        output += '\n';
      }
      
      if (warnings.length > 0) {
        output += '⚠️ WARNINGS (Should Fix):\n';
        warnings.forEach((issue, i) => {
          output += `   ${i + 1}. ${issue.message}\n`;
          if (issue.solution) output += `      → ${issue.solution}\n`;
        });
        output += '\n';
      }
      
      if (infos.length > 0) {
        output += '💡 SUGGESTIONS (Optional):\n';
        infos.forEach((issue, i) => {
          output += `   ${i + 1}. ${issue.message}\n`;
          if (issue.solution) output += `      → ${issue.solution}\n`;
        });
        output += '\n';
      }
    } else {
      output += '✅ No issues found! Everything looks good.\n\n';
    }
    
    output += 'Run this diagnostic with: ACP_DEBUG=true acp-claude-code --diagnose\n';
    
    return output;
  }
}