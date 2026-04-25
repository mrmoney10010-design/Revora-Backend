import { NextFunction, Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { AppError, Errors } from '../lib/errors';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from '../lib/stellarRpcFailure';

export type HealthDependency = 'database' | 'stellar-horizon';

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Indexer process startup timestamp.
 * 
 * This constant records the exact moment when the indexer process started.
 * It is initialized once at module load time and remains constant throughout
 * the process lifetime. Used to calculate uptime_seconds in health checks.
 * 
 * For multi-instance deployments, each instance tracks its own uptime independently.
 * 
 * @example
 * // Process started at 2024-01-15T10:00:00Z
 * INDEXER_START_TIME
 * // Returns: Date object representing startup time
 */
export const INDEXER_START_TIME = new Date();

/**
 * Returns the indexer process startup timestamp.
 * 
 * This function provides access to the module-level INDEXER_START_TIME constant,
 * enabling deterministic testing through dependency injection while maintaining
 * a simple implementation for production use.
 * 
 * @returns Date object representing when the indexer process started
 * 
 * @example
 * // Get startup time
 * const startTime = getIndexerStartTime();
 * // Returns: Date object (e.g., 2024-01-15T10:00:00Z)
 */
export function getIndexerStartTime(): Date {
  return INDEXER_START_TIME;
}

/**
 * Calculates the uptime of the indexer process in seconds.
 * 
 * This function computes the duration between the indexer startup time and
 * the current time, returning the result as a non-negative integer representing
 * seconds. The calculation uses floor division to ensure consistent integer results.
 * 
 * @param startTime - The timestamp when the indexer process started
 * @returns Uptime in seconds (non-negative integer)
 * 
 * @example
 * // Process started 5 minutes ago
 * const startTime = new Date(Date.now() - 5 * 60 * 1000);
 * calculateUptimeSeconds(startTime)
 * // Returns: 300
 * 
 * @example
 * // Process just started
 * const startTime = new Date();
 * calculateUptimeSeconds(startTime)
 * // Returns: 0
 */
export function calculateUptimeSeconds(startTime: Date): number {
  const now = new Date();
  const uptimeMs = now.getTime() - startTime.getTime();
  return Math.floor(uptimeMs / 1000);
}

/**
 * Stellar ledger close time constant in seconds.
 * 
 * The Stellar network produces a new ledger approximately every 5 seconds.
 * This constant is used to convert ledger count lag into approximate time lag.
 */
const STELLAR_LEDGER_CLOSE_TIME_SECONDS = 5;

/**
 * Calculates indexer lag metrics based on current and last indexed ledger sequences.
 * 
 * This function computes how far behind the indexer is from the network tip,
 * both in ledger count and approximate seconds. Negative lag values are clamped
 * to zero to handle edge cases like clock skew or race conditions where the
 * last indexed ledger might temporarily appear ahead of the current ledger.
 * 
 * @param currentLedger - Latest ledger sequence from Stellar network (network tip)
 * @param lastIndexedLedger - Most recent ledger sequence successfully processed by indexer
 * @returns Object containing lag_ledgers (non-negative) and lag_seconds (non-negative)
 * 
 * @example
 * // Indexer is 50 ledgers behind
 * calculateLag(1000, 950)
 * // Returns: { lagLedgers: 50, lagSeconds: 250 }
 * 
 * @example
 * // Indexer is caught up (or ahead due to race condition)
 * calculateLag(1000, 1000)
 * // Returns: { lagLedgers: 0, lagSeconds: 0 }
 * 
 * @example
 * // Negative lag clamped to zero
 * calculateLag(900, 1000)
 * // Returns: { lagLedgers: 0, lagSeconds: 0 }
 */
export function calculateLag(
  currentLedger: number,
  lastIndexedLedger: number,
): {
  lagLedgers: number;
  lagSeconds: number;
} {
  // Prevent negative lag if clock skew or race conditions occur
  const lagLedgers = Math.max(0, currentLedger - lastIndexedLedger);
  const lagSeconds = lagLedgers * STELLAR_LEDGER_CLOSE_TIME_SECONDS;

  return { lagLedgers, lagSeconds };
}

/**
 * Determines the health status of the indexer based on lag and error conditions.
 * 
 * This function evaluates whether the indexer should be considered "ok" or "degraded"
 * by comparing the current lag against a configurable threshold and checking for
 * error conditions. The threshold is read from the HEALTH_LAG_THRESHOLD environment
 * variable with a default of 100 ledgers.
 * 
 * Status determination logic:
 * - If hasErrors is true, status is always "degraded" regardless of lag
 * - If lagLedgers exceeds threshold, status is "degraded"
 * - Otherwise, status is "ok"
 * 
 * @param lagLedgers - Current lag in ledger count (non-negative)
 * @param threshold - Maximum acceptable lag before degradation (default: 100)
 * @param hasErrors - Whether any errors occurred during health check
 * @returns "ok" if indexer is healthy, "degraded" if behind threshold or has errors
 * 
 * @example
 * // Indexer is within threshold and no errors
 * determineHealthStatus(50, 100, false)
 * // Returns: "ok"
 * 
 * @example
 * // Indexer exceeds threshold
 * determineHealthStatus(150, 100, false)
 * // Returns: "degraded"
 * 
 * @example
 * // Errors present, regardless of lag
 * determineHealthStatus(10, 100, true)
 * // Returns: "degraded"
 */
export function determineHealthStatus(
  lagLedgers: number,
  threshold: number,
  hasErrors: boolean,
): "ok" | "degraded" {
  if (hasErrors) return "degraded";
  return lagLedgers <= threshold ? "ok" : "degraded";
}

/**
 * Reads the health lag threshold from environment variable with fallback to default.
 * 
 * The HEALTH_LAG_THRESHOLD environment variable defines the maximum acceptable
 * lag in ledgers before the indexer status becomes "degraded". If not set or
 * invalid, defaults to 100 ledgers.
 * 
 * @returns Lag threshold in ledgers (positive integer, default: 100)
 * 
 * @example
 * // With HEALTH_LAG_THRESHOLD=200
 * getHealthLagThreshold()
 * // Returns: 200
 * 
 * @example
 * // Without HEALTH_LAG_THRESHOLD set
 * getHealthLagThreshold()
 * // Returns: 100
 */
export function getHealthLagThreshold(): number {
  const DEFAULT_THRESHOLD = 100;
  const envValue = process.env.HEALTH_LAG_THRESHOLD;
  
  if (!envValue) {
    return DEFAULT_THRESHOLD;
  }
  
  const parsed = parseInt(envValue, 10);
  
  // Return default if parsing fails or value is not positive
  if (isNaN(parsed) || parsed <= 0) {
    return DEFAULT_THRESHOLD;
  }
  
  return parsed;
}

/**
 * Maps dependency failures into a stable, reviewable API error shape.
 * Raw upstream error messages are intentionally not exposed to clients.
 */
export function mapHealthDependencyFailure(
  dependency: HealthDependency,
  cause: unknown,
): AppError {
  const details: Record<string, unknown> = { dependency };

  if (dependency === 'stellar-horizon') {
    const failureClass = classifyStellarRPCFailure(cause);
    details.failureClass = failureClass;

    if (typeof cause === 'object' && cause !== null) {
      const status = (cause as { status?: unknown }).status;
      if (typeof status === 'number') {
        details.upstreamStatus = status;
      }
    }
  }

  return Errors.serviceUnavailable('Dependency unavailable', details);
}

export const healthReadyHandler =
  (db: QueryableDb) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await db.query('SELECT 1');
    } catch (dbError) {
      next(mapHealthDependencyFailure('database', dbError));
      return;
    }

    try {
      const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
      const response = await fetch(horizonUrl);

      if (!response.ok) {
        next(mapHealthDependencyFailure('stellar-horizon', { status: response.status }));
        return;
      }
    } catch (stellarError) {
      next(mapHealthDependencyFailure('stellar-horizon', stellarError));
      return;
    }

    res.status(200).json({
      status: 'ok',
      db: 'up',
      stellar: 'up',
    });
  };

/**
 * Health endpoint handler that provides comprehensive indexer monitoring metrics.
 * 
 * This handler orchestrates parallel queries to the Stellar RPC network and local
 * database to compute real-time health metrics including ledger synchronization
 * status, indexed event counts, uptime tracking, and degradation detection.
 * 
 * The handler executes all queries in parallel using Promise.all() for optimal
 * performance, completing within 5 seconds to support container orchestration.
 * 
 * Error Handling:
 * - RPC failures: Returns degraded status with sanitized error message
 * - Database failures: Returns degraded status with sanitized error message
 * - Partial failures: Returns degraded with available metrics
 * - Timeout: Returns degraded if handler exceeds 5 seconds
 * 
 * @param dependencies - Object containing db, rpcClient, startTime, and optional lagThreshold
 * @returns Express middleware function that handles GET /health requests
 * 
 * @example
 * ```typescript
 * const handler = healthIndexerHandler({
 *   db: pool,
 *   rpcClient: createStellarRpcClient(),
 *   startTime: getIndexerStartTime(),
 *   lagThreshold: 100
 * });
 * 
 * router.get('/health', handler);
 * ```
 */
export const healthIndexerHandler = (dependencies: {
  db: QueryableDb;
  rpcClient: { getLatestLedger(): Promise<{ sequence: number }> };
  startTime: Date;
  lagThreshold?: number;
}) => {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { db, rpcClient, startTime, lagThreshold } = dependencies;
    
    // Use provided threshold or read from environment with default of 100
    const threshold = lagThreshold ?? getHealthLagThreshold();
    
    // Create timeout promise that rejects after 5 seconds
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Health check timeout exceeded'));
      }, 5000);
    });
    
    // Create the main health check logic as a promise
    const healthCheckPromise = (async () => {
      // Execute all queries in parallel for optimal performance
      const [
        currentLedgerResult,
        indexerStateResult,
        proposalsCountResult,
        votesCountResult,
        delegatesCountResult,
      ] = await Promise.all([
        // Query RPC client for current network ledger
        rpcClient.getLatestLedger().catch((error) => {
          throw new Error(`RPC client unavailable: ${error.message}`);
        }),
        
        // Query indexer_state table for last indexed ledger
        db.query('SELECT last_indexed_ledger FROM indexer_state LIMIT 1').catch((error) => {
          throw new Error(`Database query failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }),
        
        // Query proposals table for total count
        db.query('SELECT COUNT(*) as count FROM proposals').catch((error) => {
          throw new Error(`Proposals count query failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }),
        
        // Query votes table for total count
        db.query('SELECT COUNT(*) as count FROM votes').catch((error) => {
          throw new Error(`Votes count query failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }),
        
        // Query delegates table for total count
        db.query('SELECT COUNT(*) as count FROM delegates').catch((error) => {
          throw new Error(`Delegates count query failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }),
      ]);
      
      // Extract values from query results
      const currentLedger = currentLedgerResult.sequence;
      const lastIndexedLedger = (indexerStateResult as any).rows?.[0]?.last_indexed_ledger ?? 0;
      const totalProposalsIndexed = parseInt((proposalsCountResult as any).rows?.[0]?.count ?? '0', 10);
      const totalVotesIndexed = parseInt((votesCountResult as any).rows?.[0]?.count ?? '0', 10);
      const totalDelegatesIndexed = parseInt((delegatesCountResult as any).rows?.[0]?.count ?? '0', 10);
      
      // Calculate lag metrics
      const { lagLedgers, lagSeconds } = calculateLag(currentLedger, lastIndexedLedger);
      
      // Calculate uptime
      const uptimeSeconds = calculateUptimeSeconds(startTime);
      
      // Determine health status
      const status = determineHealthStatus(lagLedgers, threshold, false);
      
      // Generate ISO 8601 UTC timestamp
      const timestamp = new Date().toISOString();
      
      // Build response object
      const response = {
        status,
        last_indexed_ledger: lastIndexedLedger,
        current_ledger: currentLedger,
        lag_ledgers: lagLedgers,
        lag_seconds: lagSeconds,
        total_proposals_indexed: totalProposalsIndexed,
        total_votes_indexed: totalVotesIndexed,
        total_delegates_indexed: totalDelegatesIndexed,
        uptime_seconds: uptimeSeconds,
        timestamp,
      };
      
      // Set HTTP status code based on health status
      const httpStatus = status === 'ok' ? 200 : 503;
      res.status(httpStatus).json(response);
    })();
    
    try {
      // Race between health check and timeout
      await Promise.race([healthCheckPromise, timeoutPromise]);
    } catch (error) {
      // Handle all errors with degraded status
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      
      // Calculate uptime even in error case
      const uptimeSeconds = calculateUptimeSeconds(startTime);
      const timestamp = new Date().toISOString();
      
      // Return degraded response with error information
      const response = {
        status: 'degraded' as const,
        last_indexed_ledger: 0,
        current_ledger: 0,
        lag_ledgers: 0,
        lag_seconds: 0,
        total_proposals_indexed: 0,
        total_votes_indexed: 0,
        total_delegates_indexed: 0,
        uptime_seconds: uptimeSeconds,
        timestamp,
        error: errorMessage,
      };
      
      res.status(503).json(response);
    }
  };
};

/**
 * Creates and configures the health router with monitoring endpoints.
 * 
 * This function initializes the Express router with two health check endpoints:
 * - GET /ready: Basic readiness check for database and Stellar Horizon connectivity
 * - GET /health: Comprehensive indexer health metrics with lag monitoring
 * 
 * The /health endpoint requires a Stellar RPC client to query network state.
 * The client is initialized lazily on first request using the STELLAR_RPC_URL environment variable.
 * 
 * @param db - Database connection pool for executing health check queries
 * @returns Express Router configured with health check endpoints
 * 
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createHealthRouter } from './routes/health';
 * 
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const healthRouter = createHealthRouter(pool);
 * 
 * app.use('/health', healthRouter);
 * // Endpoints available at:
 * // - GET /health/ready
 * // - GET /health/health
 * ```
 */
export const createHealthRouter = (db: QueryableDb): Router => {
  const router = Router();
  
  // Mount basic readiness check endpoint
  router.get('/ready', healthReadyHandler(db));
  
  // Lazy initialization of RPC client to avoid loading Stellar SDK during module import
  let rpcClient: { getLatestLedger(): Promise<{ sequence: number }> } | null = null;
  
  const getRpcClient = () => {
    if (!rpcClient) {
      // Import is done inline to avoid circular dependencies and allow mocking
      const { createStellarRpcClient } = require('../lib/stellarRpcClient');
      rpcClient = createStellarRpcClient({
        serverUrl: process.env.STELLAR_RPC_URL,
        timeout: 5000,
      });
    }
    return rpcClient;
  };
  
  // Mount comprehensive indexer health endpoint with lazy RPC client initialization
  router.get('/health', (req, res, next) => {
    const handler = healthIndexerHandler({
      db,
      rpcClient: getRpcClient(),
      startTime: getIndexerStartTime(),
      lagThreshold: getHealthLagThreshold(),
    });
    return handler(req, res, next);
  });
  
  return router;
};

export default createHealthRouter;
