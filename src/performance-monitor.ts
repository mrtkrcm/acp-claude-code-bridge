// Performance monitoring and metrics collection inspired by Gemini CLI
import { createLogger, type Logger } from './logger.js';

export interface PerformanceMetrics {
  operation: string;
  duration: number;
  timestamp: Date;
  sessionId?: string;
  success: boolean;
  memoryUsage?: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  metadata?: Record<string, unknown>;
}

export interface SystemMetrics {
  uptime: number;
  cpuUsage: NodeJS.CpuUsage;
  memoryUsage: NodeJS.MemoryUsage;
  activeOperations: number;
  totalOperations: number;
  averageResponseTime: number;
  errorRate: number;
}

export class PerformanceMonitor {
  private readonly logger: Logger;
  private readonly metrics: PerformanceMetrics[] = [];
  private readonly activeOperations: Map<string, { start: number; operation: string; sessionId?: string }> = new Map();
  private readonly MAX_METRICS_HISTORY = 1000;
  private processStartTime = Date.now();
  private totalOperations = 0;
  private totalErrors = 0;

  constructor() {
    this.logger = createLogger('PerformanceMonitor');
    this.startPeriodicReporting();
  }

  /**
   * Start tracking an operation
   */
  public startOperation(operationId: string, operation: string, sessionId?: string): void {
    this.activeOperations.set(operationId, {
      start: performance.now(),
      operation,
      sessionId
    });
    
    this.logger.debug(`Started operation: ${operation}`, { operationId, sessionId });
  }

  /**
   * End tracking an operation and record metrics
   */
  public endOperation(operationId: string, success: boolean = true, metadata?: Record<string, unknown>): PerformanceMetrics | null {
    const activeOp = this.activeOperations.get(operationId);
    if (!activeOp) {
      this.logger.warn(`Attempted to end unknown operation: ${operationId}`);
      return null;
    }

    const duration = performance.now() - activeOp.start;
    const memoryUsage = process.memoryUsage();
    
    const metric: PerformanceMetrics = {
      operation: activeOp.operation,
      duration,
      timestamp: new Date(),
      sessionId: activeOp.sessionId,
      success,
      memoryUsage,
      metadata
    };

    // Add to metrics history
    this.metrics.push(metric);
    if (this.metrics.length > this.MAX_METRICS_HISTORY) {
      this.metrics.shift();
    }

    // Update counters
    this.totalOperations++;
    if (!success) {
      this.totalErrors++;
    }

    // Clean up
    this.activeOperations.delete(operationId);

    // Log slow operations
    if (duration > 5000) { // 5 seconds
      this.logger.warn(`Slow operation detected: ${activeOp.operation}`, {
        duration: `${duration.toFixed(2)}ms`,
        sessionId: activeOp.sessionId,
        success,
        metadata
      });
    }

    this.logger.debug(`Completed operation: ${activeOp.operation}`, {
      operationId,
      duration: `${duration.toFixed(2)}ms`,
      success,
      sessionId: activeOp.sessionId
    });

    return metric;
  }

  /**
   * Record a one-shot metric without active tracking
   */
  public recordMetric(operation: string, duration: number, success: boolean = true, sessionId?: string, metadata?: Record<string, unknown>): void {
    const metric: PerformanceMetrics = {
      operation,
      duration,
      timestamp: new Date(),
      sessionId,
      success,
      memoryUsage: process.memoryUsage(),
      metadata
    };

    this.metrics.push(metric);
    if (this.metrics.length > this.MAX_METRICS_HISTORY) {
      this.metrics.shift();
    }

    this.totalOperations++;
    if (!success) {
      this.totalErrors++;
    }
  }

  /**
   * Get system-wide metrics
   */
  public getSystemMetrics(): SystemMetrics {
    const now = Date.now();
    const uptime = now - this.processStartTime;
    const cpuUsage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();

    // Calculate average response time from recent metrics
    const recentMetrics = this.metrics.slice(-100); // Last 100 operations
    const averageResponseTime = recentMetrics.length > 0 
      ? recentMetrics.reduce((sum, m) => sum + m.duration, 0) / recentMetrics.length
      : 0;

    // Calculate error rate
    const errorRate = this.totalOperations > 0 
      ? (this.totalErrors / this.totalOperations) * 100
      : 0;

    return {
      uptime,
      cpuUsage,
      memoryUsage,
      activeOperations: this.activeOperations.size,
      totalOperations: this.totalOperations,
      averageResponseTime,
      errorRate
    };
  }

  /**
   * Get metrics for a specific operation type
   */
  public getOperationMetrics(operation: string, timeRangeMs?: number): PerformanceMetrics[] {
    let filtered = this.metrics.filter(m => m.operation === operation);
    
    if (timeRangeMs) {
      const cutoff = Date.now() - timeRangeMs;
      filtered = filtered.filter(m => m.timestamp.getTime() > cutoff);
    }
    
    return filtered;
  }

  /**
   * Get metrics for a specific session
   */
  public getSessionMetrics(sessionId: string, timeRangeMs?: number): PerformanceMetrics[] {
    let filtered = this.metrics.filter(m => m.sessionId === sessionId);
    
    if (timeRangeMs) {
      const cutoff = Date.now() - timeRangeMs;
      filtered = filtered.filter(m => m.timestamp.getTime() > cutoff);
    }
    
    return filtered;
  }

  /**
   * Get performance statistics for operations
   */
  public getOperationStats(operation: string): {
    count: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    successRate: number;
    p95Duration: number;
    p99Duration: number;
  } {
    const metrics = this.getOperationMetrics(operation);
    
    if (metrics.length === 0) {
      return {
        count: 0,
        averageDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        successRate: 100,
        p95Duration: 0,
        p99Duration: 0
      };
    }

    const durations = metrics.map(m => m.duration).sort((a, b) => a - b);
    const successCount = metrics.filter(m => m.success).length;
    
    const p95Index = Math.floor(durations.length * 0.95);
    const p99Index = Math.floor(durations.length * 0.99);

    return {
      count: metrics.length,
      averageDuration: durations.reduce((sum, d) => sum + d, 0) / durations.length,
      minDuration: durations[0],
      maxDuration: durations[durations.length - 1],
      successRate: (successCount / metrics.length) * 100,
      p95Duration: durations[p95Index] || 0,
      p99Duration: durations[p99Index] || 0
    };
  }

  /**
   * Clear metrics history (useful for testing)
   */
  public clearMetrics(): void {
    this.metrics.length = 0;
    this.activeOperations.clear();
    this.totalOperations = 0;
    this.totalErrors = 0;
    this.processStartTime = Date.now();
  }

  /**
   * Get health check information
   */
  public getHealthCheck(): {
    status: 'healthy' | 'warning' | 'critical';
    checks: Array<{ name: string; status: 'pass' | 'fail'; message: string; }>;
  } {
    const checks: Array<{ name: string; status: 'pass' | 'fail'; message: string; }> = [];
    let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';

    // Memory usage check
    const memory = process.memoryUsage();
    const memoryUsageMB = memory.heapUsed / 1024 / 1024;
    if (memoryUsageMB > 1000) { // > 1GB
      checks.push({ name: 'memory', status: 'fail', message: `High memory usage: ${memoryUsageMB.toFixed(2)}MB` });
      overallStatus = 'critical';
    } else if (memoryUsageMB > 500) { // > 500MB
      checks.push({ name: 'memory', status: 'pass', message: `Elevated memory usage: ${memoryUsageMB.toFixed(2)}MB` });
      if (overallStatus === 'healthy') overallStatus = 'warning';
    } else {
      checks.push({ name: 'memory', status: 'pass', message: `Memory usage: ${memoryUsageMB.toFixed(2)}MB` });
    }

    // Error rate check
    const errorRate = this.totalOperations > 0 ? (this.totalErrors / this.totalOperations) * 100 : 0;
    if (errorRate > 10) { // > 10% errors
      checks.push({ name: 'errorRate', status: 'fail', message: `High error rate: ${errorRate.toFixed(2)}%` });
      overallStatus = 'critical';
    } else if (errorRate > 5) { // > 5% errors
      checks.push({ name: 'errorRate', status: 'pass', message: `Elevated error rate: ${errorRate.toFixed(2)}%` });
      if (overallStatus === 'healthy') overallStatus = 'warning';
    } else {
      checks.push({ name: 'errorRate', status: 'pass', message: `Error rate: ${errorRate.toFixed(2)}%` });
    }

    // Active operations check
    const activeOps = this.activeOperations.size;
    if (activeOps > 50) { // > 50 concurrent operations
      checks.push({ name: 'activeOperations', status: 'fail', message: `Too many active operations: ${activeOps}` });
      overallStatus = 'critical';
    } else if (activeOps > 20) { // > 20 concurrent operations
      checks.push({ name: 'activeOperations', status: 'pass', message: `High active operations: ${activeOps}` });
      if (overallStatus === 'healthy') overallStatus = 'warning';
    } else {
      checks.push({ name: 'activeOperations', status: 'pass', message: `Active operations: ${activeOps}` });
    }

    return { status: overallStatus, checks };
  }

  private startPeriodicReporting(): void {
    // Report system metrics every 5 minutes
    setInterval(() => {
      const metrics = this.getSystemMetrics();
      const health = this.getHealthCheck();
      
      this.logger.info('System metrics report', {
        uptime: `${(metrics.uptime / 1000 / 60).toFixed(2)} minutes`,
        memoryUsage: `${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        activeOperations: metrics.activeOperations,
        totalOperations: metrics.totalOperations,
        averageResponseTime: `${metrics.averageResponseTime.toFixed(2)}ms`,
        errorRate: `${metrics.errorRate.toFixed(2)}%`,
        healthStatus: health.status
      });
      
      if (health.status !== 'healthy') {
        this.logger.warn('Health check issues detected', { checks: health.checks });
      }
    }, 5 * 60 * 1000); // 5 minutes
  }
}

// Global performance monitor instance
let globalPerformanceMonitor: PerformanceMonitor | null = null;

export function getGlobalPerformanceMonitor(): PerformanceMonitor {
  if (!globalPerformanceMonitor) {
    globalPerformanceMonitor = new PerformanceMonitor();
  }
  return globalPerformanceMonitor;
}

export function resetGlobalPerformanceMonitor(): void {
  globalPerformanceMonitor = null;
}

// Convenience functions for common monitoring patterns
export function withPerformanceTracking<T>(
  operation: string,
  fn: () => Promise<T>,
  sessionId?: string,
  metadata?: Record<string, unknown>
): Promise<T> {
  const monitor = getGlobalPerformanceMonitor();
  const operationId = `${operation}-${Date.now()}-${Math.random()}`;
  
  monitor.startOperation(operationId, operation, sessionId);
  
  return fn().then(
    (result) => {
      monitor.endOperation(operationId, true, metadata);
      return result;
    },
    (error) => {
      monitor.endOperation(operationId, false, { ...metadata, error: error.message });
      throw error;
    }
  );
}