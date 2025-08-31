export interface ResourceLimits {
  maxMemoryMB: number; maxFileDescriptors: number; maxConcurrentOperations: number; maxConcurrentSessions: number;
  memoryWarningThresholdMB: number; memoryCriticalThresholdMB: number;
}

export interface ResourceStats {
  memoryUsageMB: number; heapUsedMB: number; heapTotalMB: number; rssUsageMB: number;
  activeFileDescriptors: number; concurrentOperations: number; activeSessions: number; uptime: number;
}

export class ResourceManager {
  private concurrentOperations = new Set<string>();
  private activeSessions = new Set<string>();
  private monitoringInterval?: NodeJS.Timeout;
  private readonly limits: ResourceLimits;
  
  constructor(limits: Partial<ResourceLimits> = {}) {
    this.limits = {
      maxMemoryMB: 1024, maxFileDescriptors: 1000, maxConcurrentOperations: 50, maxConcurrentSessions: 100,
      memoryWarningThresholdMB: 512, memoryCriticalThresholdMB: 768, ...limits
    };
    this.monitoringInterval = setInterval(() => this.checkLimits(), 30000);
  }
  
  getStats(): ResourceStats {
    const mem = process.memoryUsage();
    return {
      memoryUsageMB: Math.round(mem.rss / 1024 / 1024), heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024), rssUsageMB: Math.round(mem.rss / 1024 / 1024),
      activeFileDescriptors: this.concurrentOperations.size * 2 + this.activeSessions.size + 10,
      concurrentOperations: this.concurrentOperations.size, activeSessions: this.activeSessions.size, uptime: Math.round(process.uptime())
    };
  }
  
  canStartOperation(_operationId: string): boolean {
    const stats = this.getStats();
    return stats.memoryUsageMB <= this.limits.memoryCriticalThresholdMB && 
           stats.concurrentOperations < this.limits.maxConcurrentOperations && 
           stats.activeFileDescriptors < this.limits.maxFileDescriptors;
  }
  
  startOperation(operationId: string): boolean { 
    if (!this.canStartOperation(operationId)) return false;
    this.concurrentOperations.add(operationId); return true; 
  }
  
  finishOperation(operationId: string): void { this.concurrentOperations.delete(operationId); }
  
  addSession(sessionId: string): boolean { 
    if (this.activeSessions.size >= this.limits.maxConcurrentSessions) return false;
    this.activeSessions.add(sessionId); return true; 
  }
  
  removeSession(sessionId: string): void { this.activeSessions.delete(sessionId); }
  
  private checkLimits(): void {
    const stats = this.getStats();
    if (stats.memoryUsageMB > this.limits.memoryCriticalThresholdMB && global.gc) global.gc();
  }
  
  forceGarbageCollection(): boolean { if (global.gc) { global.gc(); return true; } return false; }
  
  getHealthStatus(): 'healthy' | 'warning' | 'critical' {
    const stats = this.getStats();
    if (stats.memoryUsageMB > this.limits.memoryCriticalThresholdMB || 
        stats.concurrentOperations >= this.limits.maxConcurrentOperations ||
        stats.activeSessions >= this.limits.maxConcurrentSessions) return 'critical';
    if (stats.memoryUsageMB > this.limits.memoryWarningThresholdMB ||
        stats.concurrentOperations > this.limits.maxConcurrentOperations * 0.8) return 'warning';
    return 'healthy';
  }
  
  destroy(): void {
    if (this.monitoringInterval) clearInterval(this.monitoringInterval);
    this.concurrentOperations.clear(); this.activeSessions.clear();
  }
}

export const globalResourceManager = new ResourceManager();
process.once('exit', () => globalResourceManager.destroy());
process.once('SIGINT', () => globalResourceManager.destroy()); 
process.once('SIGTERM', () => globalResourceManager.destroy());