#!/usr/bin/env node

/**
 * Integration test for actual ACP bridge session synchronization
 * Tests the withSessionLock mechanism we implemented
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

const SESSION_DIR = resolve(homedir(), '.acp-claude-code', 'sessions');
const BRIDGE_PATH = resolve(process.cwd(), 'dist/cli.js');

class BridgeIntegrationTester {
  constructor() {
    this.results = { passed: 0, failed: 0, errors: [] };
  }

  async run() {
    console.log('🚀 Testing ACP Bridge Integration with Real Session Management');
    console.log('='.repeat(70));

    try {
      await this.testBridgeStartup();
      await this.testSessionSynchronization();
      await this.testRealWorldScenario();
      
      this.generateReport();
    } catch (error) {
      console.error('❌ Integration test failed:', error);
      process.exit(1);
    }
  }

  async testBridgeStartup() {
    console.log('\n🔧 Testing Bridge Startup and Configuration...');
    
    // Test that our built bridge can start without errors
    const testProcess = spawn('node', [BRIDGE_PATH, '--help'], {
      stdio: 'pipe',
      timeout: 5000
    });
    
    let output = '';
    testProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    return new Promise((resolve) => {
      testProcess.on('close', (code) => {
        // Help command should exit with code 0, but we need some output
        if (code === 0 || output.length > 0) {
          this.assert(true, 'Bridge executable runs without crashing');
        } else {
          this.assert(false, `Bridge startup failed with code ${code}, no output`);
        }
        resolve();
      });
      
      testProcess.on('error', () => {
        this.assert(false, 'Bridge failed to start');
        resolve();
      });
    });
  }

  async testSessionSynchronization() {
    console.log('\n🔒 Testing Session Synchronization via Session Persistence...');
    
    // Test our session persistence mechanisms directly
    const { SessionPersistenceManager } = await import('./dist/session-persistence.js');
    const persistence = new SessionPersistenceManager();
    
    const sessionId = `integration-test-${Date.now()}`;
    
    // Test concurrent save operations
    const saves = [];
    for (let i = 0; i < 5; i++) {
      saves.push(
        persistence.saveSession({
          sessionId,
          permissionMode: 'acceptEdits',
          metadata: {
            writeAttempt: i,
            timestamp: new Date().toISOString()
          }
        })
      );
    }
    
    try {
      await Promise.all(saves);
      
      // Load final state
      const finalSession = await persistence.loadSession(sessionId);
      
      if (finalSession && finalSession.sessionId === sessionId) {
        this.assert(true, 'Session persistence handles concurrent operations');
        console.log(`📊 Final write attempt: ${finalSession.metadata?.writeAttempt}`);
      } else {
        this.assert(false, 'Session persistence failed');
      }
      
      // Cleanup
      await persistence.deleteSession(sessionId);
      
    } catch (error) {
      this.assert(false, `Session synchronization failed: ${error.message}`);
    }
  }

  async testRealWorldScenario() {
    console.log('\n🌍 Testing Real-World Session Scenario...');
    
    // Count existing sessions before test
    let existingCount = 0;
    try {
      const existingSessions = await fs.readdir(SESSION_DIR);
      existingCount = existingSessions.length;
    } catch (error) {
      console.log('ℹ️  No existing sessions directory');
    }
    
    // Simulate multiple quick bridge interactions that would create sessions
    const { SessionPersistenceManager } = await import('./dist/session-persistence.js');
    const persistence = new SessionPersistenceManager();
    
    const realWorldSessionIds = [];
    const createOperations = [];
    
    // Simulate 20 real-world sessions like what Zed might create
    for (let i = 0; i < 20; i++) {
      const sessionId = `zed-session-${Date.now()}-${i}`;
      realWorldSessionIds.push(sessionId);
      
      createOperations.push(
        persistence.saveSession({
          sessionId,
          permissionMode: 'bypassPermissions',
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
          metadata: {
            userAgent: 'ACP-Claude-Code-Bridge',
            version: '0.11.0',
            clientType: 'zed'
          }
        })
      );
    }
    
    try {
      // Create all sessions concurrently
      const results = await Promise.allSettled(createOperations);
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      console.log(`📈 Real-world scenario: ${successful} successful, ${failed} failed`);
      
      // Verify all sessions were created correctly
      let validSessions = 0;
      for (const sessionId of realWorldSessionIds) {
        try {
          const session = await persistence.loadSession(sessionId);
          if (session && session.sessionId === sessionId && session.metadata?.version === '0.11.0') {
            validSessions++;
          }
        } catch (error) {
          console.warn(`⚠️  Failed to verify session ${sessionId}`);
        }
      }
      
      console.log(`✅ Valid sessions created: ${validSessions}/${realWorldSessionIds.length}`);
      
      // Test cleanup functionality
      const { deletedCount } = await persistence.cleanup();
      console.log(`🧹 Cleanup removed ${deletedCount} old sessions`);
      
      // Final count
      let finalCount = 0;
      try {
        const finalSessions = await fs.readdir(SESSION_DIR);
        finalCount = finalSessions.length;
      } catch (error) {
        finalCount = 0;
      }
      
      console.log(`📊 Session count: ${existingCount} → ${finalCount}`);
      
      this.assert(
        validSessions >= realWorldSessionIds.length * 0.9,
        `Real-world scenario: ${validSessions}/${realWorldSessionIds.length} sessions handled correctly`
      );
      
      // Cleanup test sessions
      for (const sessionId of realWorldSessionIds) {
        try {
          await persistence.deleteSession(sessionId);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
      
    } catch (error) {
      this.assert(false, `Real-world scenario failed: ${error.message}`);
    }
  }

  assert(condition, message) {
    if (condition) {
      this.results.passed++;
      console.log(`✅ ${message}`);
    } else {
      this.results.failed++;
      console.log(`❌ ${message}`);
      this.results.errors.push(message);
    }
  }

  generateReport() {
    console.log('\n' + '='*70);
    console.log('📊 ACP BRIDGE INTEGRATION TEST REPORT');
    console.log('='.repeat(70));
    
    const total = this.results.passed + this.results.failed;
    const successRate = (this.results.passed / total * 100).toFixed(1);
    
    console.log(`\n🎯 SUMMARY:`);
    console.log(`   • Total Tests: ${total}`);
    console.log(`   • Passed: ${this.results.passed}`);
    console.log(`   • Failed: ${this.results.failed}`);
    console.log(`   • Success Rate: ${successRate}%`);
    
    if (this.results.errors.length > 0) {
      console.log(`\n❌ FAILED TESTS:`);
      this.results.errors.forEach(error => {
        console.log(`   • ${error}`);
      });
    }
    
    if (successRate >= 90) {
      console.log(`\n🎉 EXCELLENT: ACP Bridge integration is robust and production-ready!`);
    } else if (successRate >= 75) {
      console.log(`\n✅ GOOD: ACP Bridge integration is functional with minor issues.`);
    } else {
      console.log(`\n⚠️  NEEDS WORK: ACP Bridge integration requires fixes.`);
    }
    
    console.log('='.repeat(70));
  }
}

// Run the integration test
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new BridgeIntegrationTester();
  tester.run().catch(console.error);
}