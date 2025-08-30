# Next Steps: Official SDK Features Roadmap

## 🎯 Confirmed Dual-SDK Features

This roadmap focuses on features **officially supported by BOTH Claude Code SDK and ACP protocol**.

---

## 🚀 **Phase 1: High-Impact Core Features** (Priority: CRITICAL)

### **1.1 Direct File System Operations** 
**Impact:** 🔥 **HIGH** | **Complexity:** 🟡 **MEDIUM** | **Timeline:** 1-2 days

**What:** Implement ACP's direct file operations alongside Claude's tools.

**Claude Code SDK Support:**
- File operations through Read/Write/Edit tools
- Built-in file handling in query system

**ACP Protocol Support:**
- `client.readTextFile(params)` - Direct file reading
- `client.writeTextFile(params)` - Direct file writing
- `fileSystemCapabilitySchema` - Capability detection

**Implementation:**
```typescript
// Add to ClaudeACPAgent
async handleFileOperation(toolName: string, input: any) {
  // Use ACP direct file ops for simple operations
  if (toolName === 'Read' && this.client.readTextFile) {
    return await this.client.readTextFile({
      sessionId: this.currentSession,
      path: input.file_path,
      line: input.offset,
      limit: input.limit
    });
  }
  
  // Fall back to Claude tools for complex operations
  return this.handleClaudeToolUse(toolName, input);
}
```

**Benefits:**
- ✅ Faster file operations (direct vs tool indirection)
- ✅ Better error handling and user feedback
- ✅ Native client file system integration

---

### **1.2 Official Permission System**
**Impact:** 🔥 **HIGH** | **Complexity:** 🟡 **MEDIUM** | **Timeline:** 1-2 days

**What:** Replace Claude's permission prompts with official ACP permission dialogs.

**Claude Code SDK Support:**
- Permission modes: `default`, `acceptEdits`, `bypassPermissions`, `plan`
- Built-in permission handling

**ACP Protocol Support:**
- `client.requestPermission(params)` - Official permission requests
- `requestPermissionRequestSchema` - Structured permission flow

**Implementation:**
```typescript
// Add to ClaudeACPAgent
async requestUserPermission(operation: string, details: any) {
  if (this.permissionMode === 'bypassPermissions') return 'allowed';
  
  // Use official ACP permission dialog
  const response = await this.client.requestPermission({
    sessionId: this.currentSession,
    operation,
    description: `Allow ${operation}?`,
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
      { id: 'always', label: 'Always Allow' }
    ]
  });
  
  return response.outcome;
}
```

**Benefits:**
- ✅ Native client permission dialogs
- ✅ Consistent user experience across editors
- ✅ Structured permission management

---

## 📈 **Phase 2: Enhanced User Experience** (Priority: HIGH)

### **2.1 Rich Content Resources**
**Impact:** ⭐ **MEDIUM** | **Complexity:** 🟢 **LOW** | **Timeline:** 1 day

**What:** Transform tool outputs into rich ACP content resources.

**Implementation:**
```typescript
// Enhanced tool output formatting
private formatToolOutput(toolName: string, output: string, input?: any): ContentBlock[] {
  const content: ContentBlock[] = [{
    type: 'content',
    content: { type: 'text', text: output }
  }];
  
  // Add rich resource content for file operations
  if (toolName.includes('Read') && input?.file_path) {
    content.push({
      type: 'content',
      content: {
        type: 'resource',
        resource: {
          type: 'text',
          uri: `file://${input.file_path}`,
          text: output,
          mimeType: this.detectMimeType(input.file_path)
        }
      }
    });
  }
  
  return content;
}
```

### **2.2 Enhanced Session Management**
**Impact:** ⭐ **MEDIUM** | **Complexity:** 🟡 **MEDIUM** | **Timeline:** 1-2 days

**What:** Implement official ACP session loading for better persistence.

**Implementation:**
```typescript
async loadSession(params: LoadSessionRequest): Promise<void> {
  // Use official ACP session loading
  const sessionData = await this.loadSessionData(params.sessionId);
  
  if (sessionData?.claudeSessionId) {
    // Resume Claude session with official ACP integration
    this.resumeClaudeSession(sessionData.claudeSessionId);
    
    // Stream conversation history via session updates
    await this.streamSessionHistory(params.sessionId, sessionData.history);
  }
}
```

---

## 🔧 **Phase 3: Advanced Integration** (Priority: NICE TO HAVE)

### **3.1 MCP Server Bridge**
**Impact:** 💡 **SPECIALIZED** | **Complexity:** 🔴 **HIGH** | **Timeline:** 3-5 days

**What:** Expose ACP bridge as MCP server for broader ecosystem integration.

**Implementation:**
```typescript
// Create MCP server that bridges to ACP
const mcpServer = createSdkMcpServer({
  name: 'acp-claude-code-bridge',
  version: '1.0.0',
  tools: [
    {
      name: 'acp_query',
      description: 'Send query through ACP bridge',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          sessionId: { type: 'string' }
        }
      }
    }
  ]
});
```

### **3.2 Hook System Integration**
**Impact:** 💡 **SPECIALIZED** | **Complexity:** 🟡 **MEDIUM** | **Timeline:** 2-3 days

**What:** Implement Claude Code's hook system for custom integrations.

---

## 📊 **Implementation Priority Matrix**

| Feature | Impact | Complexity | Timeline | Priority |
|---------|--------|------------|----------|----------|
| **Direct File System** | 🔥 HIGH | 🟡 MEDIUM | 1-2 days | **P0** |
| **Permission System** | 🔥 HIGH | 🟡 MEDIUM | 1-2 days | **P0** |
| **Rich Content** | ⭐ MEDIUM | 🟢 LOW | 1 day | **P1** |
| **Session Loading** | ⭐ MEDIUM | 🟡 MEDIUM | 1-2 days | **P1** |
| **MCP Integration** | 💡 SPECIALIZED | 🔴 HIGH | 3-5 days | **P2** |
| **Hook System** | 💡 SPECIALIZED | 🟡 MEDIUM | 2-3 days | **P2** |

---

## 🎯 **Recommended Implementation Order**

### **Week 1: Core Features** 
1. **Direct File System Operations** (Days 1-2)
2. **Official Permission System** (Days 3-4)  
3. **Rich Content Resources** (Day 5)

### **Week 2: Enhanced Experience**
1. **Enhanced Session Management** (Days 1-2)
2. **Testing and Polish** (Days 3-4)
3. **Documentation** (Day 5)

### **Future: Advanced Features**
- MCP Server Bridge (when needed)
- Hook System Integration (for custom workflows)

---

## 🧪 **Validation Criteria**

Each feature must:
- ✅ **Use official SDK APIs only** (no custom protocols)
- ✅ **Maintain backward compatibility** 
- ✅ **Include comprehensive tests**
- ✅ **Provide clear user benefits**
- ✅ **Follow existing code patterns**

---

## 📚 **Technical References**

- **ACP Protocol**: https://agentclientprotocol.com/
- **Claude Code SDK**: `@anthropic-ai/claude-code` package
- **Zed ACP**: https://github.com/zed-industries/agent-client-protocol
- **Current Bridge**: https://github.com/mrtkrcm/acp-claude-code-bridge

---

*This roadmap focuses exclusively on features confirmed to be supported by both Claude Code SDK and ACP protocol, ensuring maximum compatibility and official support.*