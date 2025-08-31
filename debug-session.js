import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { ClaudeACPAgent } from './dist/agent.js';
import { existsSync } from 'node:fs';

async function debugSession() {
  // Create test directory
  const testDir = join(tmpdir(), `debug-sessions-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  process.env.ACP_SESSIONS_DIR = testDir;
  
  console.log('Test directory:', testDir);
  console.log('Environment variable:', process.env.ACP_SESSIONS_DIR);
  
  // Reset the singleton
  const persistenceModule = await import('./dist/session-persistence.js');
  persistenceModule.defaultManager = null;
  
  // Create agent
  const agent = new ClaudeACPAgent('debug-client');
  
  // Create session
  console.log('Creating new session...');
  const response = await agent.newSession({ sessionId: 'debug-test-session' });
  console.log('Session created:', response);
  
  // Check if file exists
  const sessionFile = join(testDir, 'debug-test-session.json');
  console.log('Session file path:', sessionFile);
  console.log('Session file exists:', existsSync(sessionFile));
  
  if (existsSync(sessionFile)) {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(sessionFile, 'utf-8');
    console.log('Session file content:', content);
  }
}

debugSession().catch(console.error);