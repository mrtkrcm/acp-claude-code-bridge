export enum CircuitState { CLOSED = 'CLOSED', OPEN = 'OPEN', HALF_OPEN = 'HALF_OPEN' }

export interface CircuitBreakerOptions {
  failureThreshold: number; successThreshold: number; timeout: number; monitoringPeriod: number;
}

export interface CircuitBreakerStats {
  state: CircuitState; failures: number; successes: number; 
  lastFailureTime?: number; lastSuccessTime?: number;
  totalCalls: number; totalFailures: number; totalSuccesses: number;
}

export class CircuitBreaker<T = unknown, R = unknown> {
  private state = CircuitState.CLOSED;
  private failures = 0; private successes = 0; private nextAttempt = 0;
  private lastFailureTime?: number; private lastSuccessTime?: number;
  private totalCalls = 0; private totalFailures = 0; private totalSuccesses = 0;
  private readonly opts: CircuitBreakerOptions;
  
  constructor(private readonly fn: (args: T) => Promise<R>, options: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { failureThreshold: 5, successThreshold: 3, timeout: 60000, monitoringPeriod: 120000, ...options };
  }
  
  async execute(args: T): Promise<R> {
    this.totalCalls++;
    this.cleanupOldFailures();
    
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) throw new Error('Circuit breaker is OPEN - failing fast');
      this.state = CircuitState.HALF_OPEN; this.successes = 0;
    }
    
    try {
      const result = await this.fn(args);
      this.onSuccess(); return result;
    } catch (error) { this.onFailure(); throw error; }
  }
  
  private onSuccess(): void {
    this.lastSuccessTime = Date.now(); this.totalSuccesses++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      if (++this.successes >= this.opts.successThreshold) {
        this.state = CircuitState.CLOSED; this.failures = this.successes = 0;
      }
    } else if (this.state === CircuitState.CLOSED) this.failures = Math.max(0, this.failures - 1);
    else { this.state = CircuitState.CLOSED; this.failures = this.successes = 0; }
  }
  
  private onFailure(): void {
    this.lastFailureTime = Date.now(); this.failures++; this.totalFailures++;
    
    if ((this.state === CircuitState.CLOSED && this.failures >= this.opts.failureThreshold) || this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN; this.nextAttempt = Date.now() + this.opts.timeout;
    }
  }
  
  private cleanupOldFailures(): void {
    const cutoff = Date.now() - this.opts.monitoringPeriod;
    if (this.lastFailureTime && this.lastFailureTime < cutoff) this.failures = Math.max(0, this.failures - 1);
  }
  
  getStats(): CircuitBreakerStats { return { state: this.state, failures: this.failures, successes: this.successes, lastFailureTime: this.lastFailureTime, lastSuccessTime: this.lastSuccessTime, totalCalls: this.totalCalls, totalFailures: this.totalFailures, totalSuccesses: this.totalSuccesses }; }
  
  forceOpen(timeout?: number): void { this.state = CircuitState.OPEN; this.nextAttempt = Date.now() + (timeout || this.opts.timeout); }
  forceClosed(): void { this.state = CircuitState.CLOSED; this.failures = this.successes = 0; }
  isHealthy(): boolean { return this.state === CircuitState.CLOSED; }
}

export const CLAUDE_SDK_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 8,      // Allow more failures before opening (was 3)
  successThreshold: 3,      // Require more successes to close (was 2) 
  timeout: 10000,           // Reduce timeout to 10 seconds (was 30000)
  monitoringPeriod: 120000  // Keep 2-minute monitoring period
};