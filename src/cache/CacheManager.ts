import * as fs from 'fs';
import { createLogger, type Logger } from "../logger.js";

// ========== PERFORMANCE CACHING SYSTEM ==========

export interface CacheEntry<T = unknown> {
  value: T;
  timestamp: number;
  ttl?: number;
  hits: number;
  lastAccessed: number;
  size: number;
  metadata?: Record<string, unknown>;
}

export interface CacheOptions {
  maxSize: number;
  defaultTTL: number;
  enableCompression?: boolean;
  strategy: 'lru' | 'lfu' | 'fifo';
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
  hitRate: number;
  totalRequests: number;
  averageAccessTime: number;
}

export interface PerformanceMetrics {
  operationCount: number;
  totalTime: number;
  averageTime: number;
  p95Time: number;
  p99Time: number;
  cacheHitRate: number;
  memoryUsage: number;
  throughput: number;
}

/**
 * Manages performance caching with multiple cache types and strategies
 */
export class CacheManager {
  private resultCache: Map<string, CacheEntry> = new Map();
  private fileCache: Map<string, CacheEntry<string>> = new Map();
  private computationCache: Map<string, CacheEntry> = new Map();
  private readonly cacheOptions: CacheOptions;
  private cacheStats: CacheStats;
  private readonly performanceMetrics: PerformanceMetrics;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;

  constructor(options?: Partial<CacheOptions>) {
    this.logger = createLogger('CacheManager');

    this.cacheOptions = {
      maxSize: parseInt(process.env.ACP_CACHE_MAX_SIZE || '1000'),
      defaultTTL: parseInt(process.env.ACP_CACHE_TTL || '300000'), // 5 minutes
      enableCompression: process.env.ACP_CACHE_COMPRESSION === 'true',
      strategy: (process.env.ACP_CACHE_STRATEGY as 'lru' | 'lfu' | 'fifo') || 'lru',
      ...options
    };

    this.cacheStats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      maxSize: this.cacheOptions.maxSize,
      hitRate: 0,
      totalRequests: 0,
      averageAccessTime: 0
    };

    this.performanceMetrics = {
      operationCount: 0,
      totalTime: 0,
      averageTime: 0,
      p95Time: 0,
      p99Time: 0,
      cacheHitRate: 0,
      memoryUsage: 0,
      throughput: 0
    };

    // Start cache maintenance
    this.maintenanceTimer = setInterval(() => this.maintainCache(), 60000);
    this.logger.info(`Cache system initialized: ${this.cacheOptions.maxSize} max entries, ${this.cacheOptions.strategy} strategy`);
  }

  /**
   * Gets a cached result or computes and caches it
   */
  async getCachedResult<T>(
    key: string,
    computeFn: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.generateCacheKey(key);
    const cached = this.resultCache.get(cacheKey);

    const startTime = Date.now();

    if (cached && this.isCacheEntryValid(cached)) {
      cached.hits++;
      cached.lastAccessed = Date.now();
      this.cacheStats.hits++;
      this.updateCacheStats(startTime - Date.now());
      this.logger.debug(`Cache hit for key: ${key}`);
      return cached.value as T;
    }

    // Cache miss - compute the result
    this.cacheStats.misses++;
    const result = await computeFn();
    const endTime = Date.now();

    // Cache the result
    this.setCachedResult(cacheKey, result, ttl);
    this.updateCacheStats(endTime - startTime);

    this.logger.debug(`Cache miss for key: ${key}, computed in ${endTime - startTime}ms`);
    return result;
  }

  /**
   * Caches a file content with automatic invalidation on modification
   */
  async getCachedFileContent(filePath: string): Promise<string | null> {
    const cacheKey = `file:${filePath}`;
    const cached = this.fileCache.get(cacheKey);

    if (cached && this.isCacheEntryValid(cached)) {
      // Check if file has been modified
      try {
        const stats = fs.statSync(filePath);
        if (stats.mtime.getTime() <= cached.timestamp) {
          cached.hits++;
          cached.lastAccessed = Date.now();
          this.cacheStats.hits++;
          this.logger.debug(`File cache hit: ${filePath}`);
          return cached.value;
        }
      } catch {
        // File doesn't exist, remove from cache
        this.fileCache.delete(cacheKey);
        return null;
      }
    }

    // Cache miss - read the file
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.setCachedFileContent(filePath, content);
      this.cacheStats.misses++;
      this.logger.debug(`File cache miss: ${filePath}`);
      return content;
    } catch {
      this.logger.warn(`Failed to read file for caching: ${filePath}`);
      return null;
    }
  }

  /**
   * Caches expensive computations
   */
  getCachedComputation<T>(
    key: string,
    computeFn: () => T,
    dependencies: string[] = []
  ): T {
    const cacheKey = `comp:${key}:${dependencies.sort().join(',')}`;
    const cached = this.computationCache.get(cacheKey);

    if (cached && this.isCacheEntryValid(cached)) {
      cached.hits++;
      cached.lastAccessed = Date.now();
      this.cacheStats.hits++;
      this.logger.debug(`Computation cache hit: ${key}`);
      return cached.value as T;
    }

    // Cache miss - compute the result
    const result = computeFn();
    this.setCachedComputation(cacheKey, result);
    this.cacheStats.misses++;
    this.logger.debug(`Computation cache miss: ${key}`);
    return result;
  }

  /**
   * Sets a cached result
   */
  setCachedResult(key: string, value: unknown, ttl?: number): void {
    const entry: CacheEntry = {
      value,
      timestamp: Date.now(),
      ttl: ttl || this.cacheOptions.defaultTTL,
      hits: 0,
      lastAccessed: Date.now(),
      size: this.estimateSize(value)
    };

    this.resultCache.set(key, entry);
    this.enforceCacheSize(this.resultCache);
    this.cacheStats.size = this.resultCache.size;
  }

  /**
   * Sets a cached file content
   */
  setCachedFileContent(filePath: string, content: string): void {
    const entry: CacheEntry<string> = {
      value: content,
      timestamp: Date.now(),
      ttl: this.cacheOptions.defaultTTL,
      hits: 0,
      lastAccessed: Date.now(),
      size: Buffer.byteLength(content, 'utf-8')
    };

    this.fileCache.set(`file:${filePath}`, entry);
    this.enforceCacheSize(this.fileCache);
  }

  /**
   * Sets a cached computation
   */
  setCachedComputation(key: string, value: unknown): void {
    const entry: CacheEntry = {
      value,
      timestamp: Date.now(),
      ttl: this.cacheOptions.defaultTTL * 2, // Longer TTL for computations
      hits: 0,
      lastAccessed: Date.now(),
      size: this.estimateSize(value)
    };

    this.computationCache.set(key, entry);
    this.enforceCacheSize(this.computationCache);
  }

  /**
   * Generates a cache key from various inputs
   */
  private generateCacheKey(...parts: (string | number | boolean)[]): string {
    return parts.map(part => String(part)).join('|');
  }

  /**
   * Checks if a cache entry is still valid
   */
  private isCacheEntryValid(entry: CacheEntry): boolean {
    const now = Date.now();
    const ttl = entry.ttl || this.cacheOptions.defaultTTL;
    return (now - entry.timestamp) < ttl;
  }

  /**
   * Estimates the size of a value in bytes
   */
  private estimateSize(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf-8');
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 1;
    if (Array.isArray(value)) return value.length * 8; // Rough estimate
    if (typeof value === 'object') return JSON.stringify(value).length;
    return 8; // Default size
  }

  /**
   * Enforces cache size limits using the configured strategy
   */
  private enforceCacheSize(cache: Map<string, CacheEntry>): void {
    while (cache.size >= this.cacheOptions.maxSize) {
      let keyToRemove: string | null = null;

      switch (this.cacheOptions.strategy) {
        case 'lru': {
          // Remove least recently used
          let oldestAccess = Date.now();
          for (const [key, entry] of cache.entries()) {
            if (entry.lastAccessed < oldestAccess) {
              oldestAccess = entry.lastAccessed;
              keyToRemove = key;
            }
          }
          break;
        }

        case 'lfu': {
          // Remove least frequently used
          let fewestHits = Infinity;
          for (const [key, entry] of cache.entries()) {
            if (entry.hits < fewestHits) {
              fewestHits = entry.hits;
              keyToRemove = key;
            }
          }
          break;
        }

        case 'fifo': {
          // Remove first (oldest)
          const iterator = cache.keys().next();
          keyToRemove = iterator.done ? null : iterator.value;
          break;
        }
      }

      if (keyToRemove) {
        cache.delete(keyToRemove);
        this.cacheStats.evictions++;
      }
    }
  }

  /**
   * Maintains cache by cleaning expired entries
   */
  private maintainCache(): void {
    const now = Date.now();
    let cleaned = 0;

    // Clean result cache
    for (const [key, entry] of this.resultCache.entries()) {
      if ((now - entry.timestamp) >= (entry.ttl || this.cacheOptions.defaultTTL)) {
        this.resultCache.delete(key);
        cleaned++;
      }
    }

    // Clean file cache
    for (const [key, entry] of this.fileCache.entries()) {
      if ((now - entry.timestamp) >= (entry.ttl || this.cacheOptions.defaultTTL)) {
        this.fileCache.delete(key);
        cleaned++;
      }
    }

    // Clean computation cache
    for (const [key, entry] of this.computationCache.entries()) {
      if ((now - entry.timestamp) >= (entry.ttl || this.cacheOptions.defaultTTL)) {
        this.computationCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cache maintenance: cleaned ${cleaned} expired entries`);
    }

    // Update cache statistics
    this.updateCacheStats(0);
  }

  /**
   * Updates cache statistics
   */
  private updateCacheStats(accessTime: number): void {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    if (total > 0) {
      this.cacheStats.hitRate = this.cacheStats.hits / total;
      this.cacheStats.totalRequests = total;
      this.cacheStats.averageAccessTime = (this.cacheStats.averageAccessTime + accessTime) / 2;
    }

    // Update performance metrics
    this.performanceMetrics.cacheHitRate = this.cacheStats.hitRate;
    this.performanceMetrics.memoryUsage = this.estimateTotalCacheSize();
  }

  /**
   * Estimates total cache size in bytes
   */
  private estimateTotalCacheSize(): number {
    let totalSize = 0;

    for (const entry of this.resultCache.values()) {
      totalSize += entry.size;
    }

    for (const entry of this.fileCache.values()) {
      totalSize += entry.size;
    }

    for (const entry of this.computationCache.values()) {
      totalSize += entry.size;
    }

    return totalSize;
  }

  /**
   * Gets cache statistics for monitoring
   */
  getCacheStats(): CacheStats & PerformanceMetrics {
    return {
      ...this.cacheStats,
      ...this.performanceMetrics
    };
  }

  /**
   * Clears all caches
   */
  clearAllCaches(): void {
    this.resultCache.clear();
    this.fileCache.clear();
    this.computationCache.clear();

    this.cacheStats.size = 0;
    this.cacheStats.evictions = 0;

    this.logger.info('All caches cleared');
  }

  /**
   * Invalidates cache entries by pattern
   */
  invalidateCache(pattern: string): number {
    let invalidated = 0;
    const regex = new RegExp(pattern);

    // Invalidate result cache
    for (const [key] of this.resultCache) {
      if (regex.test(key)) {
        this.resultCache.delete(key);
        invalidated++;
      }
    }

    // Invalidate file cache
    for (const [key] of this.fileCache) {
      if (regex.test(key)) {
        this.fileCache.delete(key);
        invalidated++;
      }
    }

    // Invalidate computation cache
    for (const [key] of this.computationCache) {
      if (regex.test(key)) {
        this.computationCache.delete(key);
        invalidated++;
      }
    }

    if (invalidated > 0) {
      this.logger.debug(`Invalidated ${invalidated} cache entries matching pattern: ${pattern}`);
    }

    return invalidated;
  }

  /**
   * Cleans up cache resources
   */
  cleanup(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this.clearAllCaches();
    this.logger.info('Cache manager cleaned up');
  }
}
