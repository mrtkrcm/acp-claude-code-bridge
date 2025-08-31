#!/usr/bin/env node

/**
 * Maintenance and cleanup script for ACP-Claude-Code bridge
 * Cleans up test files, old logs, and session data
 */

import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

const SESSION_DIR = resolve(homedir(), '.acp-claude-code', 'sessions');
const LOG_DIR = resolve(process.cwd(), 'logs');

class MaintenanceManager {
  constructor() {
    this.stats = {
      sessionsRemoved: 0,
      logsCompacted: 0,
      spaceFreed: 0
    };
  }

  async run() {
    console.log('🧹 Starting ACP Bridge Maintenance');
    console.log('='.repeat(50));

    try {
      await this.cleanupTestSessions();
      await this.compactLogs();
      await this.cleanupOldSessions();
      
      this.printSummary();
    } catch (error) {
      console.error('❌ Maintenance failed:', error.message);
      process.exit(1);
    }
  }

  async cleanupTestSessions() {
    console.log('\n🧪 Cleaning up test session files...');
    
    try {
      const sessions = await fs.readdir(SESSION_DIR);
      const testPatterns = [
        'test-', 'load-test-', 'memory-test-', 'persistence-test-',
        'zed-session-', 'ancient-', 'disk-', 'bad-json-', 'restricted-'
      ];
      
      let removedCount = 0;
      let freedSpace = 0;
      
      for (const session of sessions) {
        const isTestFile = testPatterns.some(pattern => session.includes(pattern));
        
        if (isTestFile) {
          const filePath = join(SESSION_DIR, session);
          try {
            const stats = await fs.stat(filePath);
            freedSpace += stats.size;
            await fs.unlink(filePath);
            removedCount++;
          } catch (error) {
            // Ignore individual file errors
          }
        }
      }
      
      this.stats.sessionsRemoved = removedCount;
      this.stats.spaceFreed += freedSpace;
      
      if (removedCount > 0) {
        console.log(`✅ Removed ${removedCount} test session files (${Math.round(freedSpace/1024)}KB freed)`);
      } else {
        console.log('✅ No test session files to clean');
      }
    } catch (error) {
      console.log('ℹ️  No session directory found or accessible');
    }
  }

  async compactLogs() {
    console.log('\n📄 Compacting log files...');
    
    try {
      const logFile = join(LOG_DIR, 'acp-bridge.log');
      
      // Check if log file exists and is large
      const stats = await fs.stat(logFile);
      const sizeMB = stats.size / (1024 * 1024);
      
      if (sizeMB > 1) { // If log is larger than 1MB
        // Keep only last 100 lines
        const content = await fs.readFile(logFile, 'utf8');
        const lines = content.split('\n');
        const recentLines = lines.slice(-100).join('\n');
        
        await fs.writeFile(logFile, recentLines);
        
        const freedSpace = stats.size - Buffer.byteLength(recentLines);
        this.stats.logsCompacted = 1;
        this.stats.spaceFreed += freedSpace;
        
        console.log(`✅ Compacted log file (${sizeMB.toFixed(1)}MB → ${(Buffer.byteLength(recentLines)/1024/1024).toFixed(1)}MB)`);
      } else {
        console.log('✅ Log file size is acceptable');
      }
    } catch (error) {
      console.log('ℹ️  No log files to compact');
    }
  }

  async cleanupOldSessions() {
    console.log('\n⏰ Cleaning up old session files (>7 days)...');
    
    try {
      const sessions = await fs.readdir(SESSION_DIR);
      const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      
      let removedCount = 0;
      let freedSpace = 0;
      
      for (const session of sessions) {
        const filePath = join(SESSION_DIR, session);
        try {
          const stats = await fs.stat(filePath);
          
          // Remove files older than 1 week
          if (stats.mtime.getTime() < oneWeekAgo) {
            freedSpace += stats.size;
            await fs.unlink(filePath);
            removedCount++;
          }
        } catch (error) {
          // Ignore individual file errors
        }
      }
      
      if (removedCount > 0) {
        this.stats.sessionsRemoved += removedCount;
        this.stats.spaceFreed += freedSpace;
        console.log(`✅ Removed ${removedCount} old session files (${Math.round(freedSpace/1024)}KB freed)`);
      } else {
        console.log('✅ No old session files to clean');
      }
    } catch (error) {
      console.log('ℹ️  No session directory found or accessible');
    }
  }

  printSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 MAINTENANCE SUMMARY');
    console.log('='.repeat(50));
    
    console.log(`🗑️  Sessions removed: ${this.stats.sessionsRemoved}`);
    console.log(`📄 Log files compacted: ${this.stats.logsCompacted}`);
    console.log(`💾 Total space freed: ${Math.round(this.stats.spaceFreed/1024)}KB`);
    
    if (this.stats.spaceFreed > 0) {
      console.log('\n🎉 Maintenance completed successfully!');
    } else {
      console.log('\n✨ System is already clean!');
    }
  }
}

// Run maintenance if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const maintenance = new MaintenanceManager();
  maintenance.run().catch(console.error);
}

export { MaintenanceManager };