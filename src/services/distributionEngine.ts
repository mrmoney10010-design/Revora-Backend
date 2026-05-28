import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { Decimal } from '../lib/decimal';
import { 
  classifyStellarRPCFailure, 
  StellarRPCFailureClass,
  StellarRPCFailure,
  StellarRPCFailureContext 
} from '../lib/stellarRpcFailure';

/**
 * @title DistributionEngine
 * @notice Computes per-investor payout amounts based on token balances and persists them.
 * @dev This service handles the core logic for revenue distribution, including:
 * 1. Balance acquisition (via provider or repository)
 * 2. Decimal-based proration of revenue based on balances (exact-to-the-cent)
 * 3. Largest-share reconciliation adjustment to ensure total payout exactly equals revenue
 * 4. Persistence of distribution runs and individual payouts with a retry strategy
 * 5. Batch processing for large payout sets with partial failure handling
 * 
 * **Precision & Rounding:**
 * All financial calculations use the Decimal utility (src/lib/decimal.ts) which operates
 * on BigInt internally to eliminate IEEE 754 floating-point rounding errors. This ensures:
 * - Exact-to-the-cent payout calculations
 * - No penny-pinching or revenue leakage due to rounding
 * - Deterministic, reproducible results across all invocations
 * 
 * **Security Assumptions & Risk Notes:**
 * - **Trust Boundary**: Balance data is assumed to be validated by the provided `balanceProvider` or `offeringRepo`.
 * - **Idempotency**: Runs are keyed by `(offeringId, periodId, totalAmount)`. Multiple calls with same params will resume or return existing run.
 * - **Data Leakage**: Stellar RPC failures are classified via `classifyStellarRPCFailure` to ensure raw upstream error strings do not leak to client.
 * - **Transactionality**: Payouts are persisted individually within batches. Partial failures are recorded in the `distribution_run` status.
 * - **Rounding**: The "Largest-Share Adjustment" strategy is used to ensure total payouts exactly match `revenueAmount` to the cent, preventing minor leakage or shortfall.
 */

export interface BalanceRow {
  investor_id: string;
  balance: number; // numeric balance; precision handled by callers/tests
}

export interface DistributionResult {
  distributionRun: any;
  payouts: Array<{ investor_id: string; amount: string }>;
}

/** Enhanced result type with batch processing details */
export interface DistributionBatchResult {
  distributionRun: any;
  successfulPayouts: Array<{ investor_id: string; amount: string }>;
  failedPayouts: Array<{ investor_id: string; amount: string; error: string; errorClass?: string }>;
  totalPayouts: number;
}

export interface DistributionEngineOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  /** Log retry attempts to console/logger */
  logRetries?: boolean;
  /** Max payouts per batch to prevent overwhelming the database (default: 50) */
  batchSize?: number;
}

export class DistributionEngine {
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly backoffFactor: number;
  private readonly logRetries: boolean;
  private readonly batchSize: number;
  private readonly logger: Logger;

  constructor(
    private offeringRepo: any,
    private distributionRepo: any,
    private balanceProvider?: { getBalances: (offeringId: string, period: any) => Promise<BalanceRow[]> },
    options: DistributionEngineOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.logRetries = options.logRetries ?? false;
    this.batchSize = options.batchSize ?? 50;
    this.logger = globalLogger;
  }

  /**
   * @notice Distribute revenueAmount across investors for an offering and period.
   * @dev Security Assumptions:
   * - revenueAmount must be strictly positive.
   * - offeringId must be valid and exist (checked by repo).
   * - totalBalance must be > 0.
   * - Payouts are persisted with a retry strategy to handle transient failures.
   * - Batch processing prevents overwhelming the database with large payout sets.
   *
   * @param offeringId The unique identifier of the offering
   * @param period The timeframe for which the distribution is being made
   * @param revenueAmount The total amount of revenue to be distributed
   * @returns The created distribution run and the list of payouts
   */
  async distribute(
    offeringId: string,
    period: { id: string; start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionResult> {
    const result = await this.distributeWithBatch(offeringId, period, revenueAmount);
    
    if (result.failedPayouts.length > 0) {
      const firstFailure = result.failedPayouts[0];
      const errorMsg = firstFailure.errorClass 
        ? `Distribution failed: ${firstFailure.errorClass}`
        : 'Distribution completed with partial failures';
      throw Errors.internal(errorMsg);
    }

    // Backward compatibility: return original shape
    return {
      distributionRun: result.distributionRun,
      payouts: result.successfulPayouts,
    };
  }

  /**
   * @notice Distribute revenueAmount with batch processing and partial failure tracking.
   * @dev This is the enhanced version that returns detailed batch results.
   * 
   * **Decimal-Based Proration Algorithm:**
   * This method uses exact-to-the-cent calculations via the Decimal utility to ensure
   * financial accuracy. The algorithm works as follows:
   *
   * 1. **Precise Share Calculation**: Each investor's raw share is calculated as:
   *    `share = (investor_balance / total_balance) * revenueAmount` using Decimal arithmetic.
   *    This maintains up to 18 decimal places of precision internally.
   *
   * 2. **Rounding to Cents**: Each share is independently rounded to 2 decimal places
   *    using the "round half up" strategy, producing an amount in cents.
   *
   * 3. **Reconciliation Adjustment** (Largest-Share Method):
   *    - Calculate the sum of all rounded amounts.
   *    - Compute the difference: `diff = revenueAmount - roundedSum`.
   *    - If `diff != 0`, identify the investor with the largest raw share.
   *    - Adjust that investor's payout by exactly `diff` to ensure the total equals revenueAmount.
   *    - This approach prioritizes accuracy and prevents penny-pinching edge cases.
   *
   * **Why This Is Secure & Efficient:**
   * - **No Floating-Point Errors**: Uses BigInt internally to eliminate IEEE 754 artifacts.
   * - **Exact-to-the-Cent**: All calculations preserve exactly 2 decimal places.
   * - **Deterministic**: The same inputs always produce identical payouts (idempotent).
   * - **Transparent**: The largest-share recipient is implicitly "adjusted" for rounding, 
   *   which is the investor who benefits most from the proration anyway.
   *
   * **Example**:
   *   Investors: i1 (balance 100), i2 (balance 100), i3 (balance 100)
   *   Revenue: $100.00
   *   Shares: 33.333... each → rounded to 33.33, 33.33, 33.33
   *   Sum: $99.99
   *   Diff: $0.01 (goes to investor with largest raw share, which is a tie, so first is adjusted)
   *   Final: 33.34, 33.33, 33.33 (or similar depending on rounding)
   *
   * @param offeringId The unique identifier of the offering
   * @param period The timeframe for which the distribution is being made
   * @param revenueAmount The total amount of revenue to be distributed
   * @returns Batch result with successful and failed payouts
   */
  async distributeWithBatch(
    offeringId: string,
    period: { start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionBatchResult> {
    const startTime = Date.now();

    // 1. Validation
    if (!offeringId) throw Errors.badRequest('offeringId is required');
    if (revenueAmount <= 0) throw Errors.badRequest('revenueAmount must be > 0');
    if (!period || !period.id || !period.end) throw Errors.badRequest('Valid distribution period with ID is required');

    const amtStr = revenueAmount.toFixed(2);

    // 2. Idempotency Check: Look for an existing run
    let run = await this.distributionRepo.findRunByParams(offeringId, period.id, amtStr);
    
    if (run) {
      if (run.status === 'completed') {
        this.logger.info('Distribution already completed, returning cached results', {
          offeringId,
          periodId: period.id,
          runId: run.id,
        });
        const existingPayouts = await this.distributionRepo.getPayoutsForRun(run.id);
        return {
          distributionRun: run,
          successfulPayouts: existingPayouts.map((p: any) => ({ investor_id: p.investor_id, amount: p.amount })),
          failedPayouts: [],
          totalPayouts: existingPayouts.length,
        };
      }
      this.logger.info('Resuming partially completed distribution', {
        offeringId,
        periodId: period.id,
        runId: run.id,
        currentStatus: run.status
      });
    }

    // 3. Acquire balances with retry and classification
    let balances: BalanceRow[] = [];
    try {
      balances = await this.withRetry(() => this.fetchBalances(offeringId, period));
    } catch (err) {
      const failure = classifyStellarRPCFailure(err, {
        operation: 'fetchBalances',
        offeringId,
        periodId: period.id,
      });
      this.logger.error('Failed to acquire balances', {
        offeringId,
        periodId: period.id,
        error: err instanceof Error ? err.message : String(err),
        failureClass: failure.class
      });
      throw Errors.serviceUnavailable(`Failed to acquire balances: ${failure.class}`);
    }

    if (!balances || balances.length === 0) {
      throw Errors.badRequest('No investors or balances found for offering');
    }

    // 4. Sum balances and compute shares using Decimal for precision
    // ──────────────────────────────────────────────────────────────
    // Use BigInt-based Decimal arithmetic to avoid floating-point inaccuracies.
    // This ensures exact-to-the-cent calculations for financial correctness.
    // Convert all balances to Decimal first, then sum using Decimal arithmetic.
    // Convert balances to Decimal without performing JS floating-point arithmetic.
    // - Format the incoming numeric value to a decimal string with high precision
    //   (up to 18 places) to preserve any fractional parts.
    // - Construct a Decimal from that string, then round to 2 decimal places
    //   using `toSorobanI128(2, 'round')` to produce cent-precision values.
    const balanceDecimals = balances.map((b) => {
      const rawStr = (b.balance).toFixed(18); // string representation with up to 18 decimals
      const rawDecimal = new Decimal(rawStr);
      const scaled = rawDecimal.toSorobanI128(2, 'round');
      return Decimal.fromScaledBigInt(scaled, 2);
    });

    const totalBalanceDecimal = balanceDecimals.reduce((sum, bd) => sum.add(bd), new Decimal('0'));

    if (totalBalanceDecimal.isZero() || totalBalanceDecimal.isNegative()) {
      throw Errors.badRequest('Total balance must be > 0 to distribute revenue');
    }

    // Convert `revenueAmount` to a Decimal without JS numeric rounding.
    // Use a high-precision string representation then round to 2 decimals via Decimal.
    const revenueRawStr = revenueAmount.toFixed(18);
    const revenueRawDecimal = new Decimal(revenueRawStr);
    const revenueScaled = revenueRawDecimal.toSorobanI128(2, 'round');
    const revenueDecimal = Decimal.fromScaledBigInt(revenueScaled, 2);

    // Compute raw shares as Decimals with full precision (up to 18 decimal places).
    // These are NOT yet rounded; they preserve the exact mathematical division result.
    interface RawShare {
      investor_id: string;
      rawShare: Decimal;
    }
    const rawShares: RawShare[] = balances.map((b, index) => {
      // Use the pre-converted balance Decimal instead of reconverting
      const balanceDecimal = balanceDecimals[index];
      // rawShare = (balance / totalBalance) * revenueAmount
      const share = balanceDecimal.divide(totalBalanceDecimal).multiply(revenueDecimal);
      return {
        investor_id: b.investor_id,
        rawShare: share,
      };
    });

    // Round each raw share to 2 decimal places (cents) using "round half up" strategy.
    // Convert via toSorobanI128 with scale=2 for consistent rounding behavior.
    interface RoundedShare {
      investor_id: string;
      amount: Decimal;
      rawShare: Decimal;
    }
    const rounded: RoundedShare[] = rawShares.map((r) => {
      // toSorobanI128(2, 'round') scales to 2 decimals and applies round-half-up
      const scaledValue = r.rawShare.toSorobanI128(2, 'round');
      const amountDecimal = Decimal.fromScaledBigInt(scaledValue, 2);
      return {
        investor_id: r.investor_id,
        amount: amountDecimal,
        rawShare: r.rawShare,
      };
    });

    // Calculate total of all rounded amounts to determine if reconciliation is needed.
    const roundedSum = rounded.reduce(
      (sum, r) => sum.add(r.amount),
      new Decimal('0')
    );

    // **Largest-Share Reconciliation Adjustment**
    // ────────────────────────────────────────────
    // Compute the difference between the intended revenue and the sum of rounded amounts.
    // Due to independent rounding, this difference can be non-zero (typically ±0.01).
    // Round the difference to 2 decimal places to ensure it fits within cent precision.
    const rawDiff = revenueDecimal.subtract(roundedSum);
    const diffScaled = rawDiff.toSorobanI128(2, 'round');
    const diff = Decimal.fromScaledBigInt(diffScaled, 2);

    if (!diff.isZero()) {
      // Find the investor with the largest raw share and adjust their payout by `diff`.
      // This ensures total payouts always equal revenueAmount exactly.
      // Rationale: The investor with the largest share implicitly benefits most from
      // the proration algorithm, so the reconciliation adjustment is fair.
      let maxIdx = 0;
      for (let i = 1; i < rawShares.length; i++) {
        if (rawShares[i].rawShare.compareTo(rawShares[maxIdx].rawShare) > 0) {
          maxIdx = i;
        }
      }
      // Adjust the largest share investor by the difference
      rounded[maxIdx].amount = rounded[maxIdx].amount.add(diff);
    }

    // 5. Ensure distribution run exists and is in 'processing' state
    if (!run) {
      try {
        run = await this.withRetry(() =>
          this.distributionRepo.createDistributionRun({
            offering_id: offeringId,
            period_id: period.id,
            total_amount: amtStr,
            run_at: period.end,
            status: 'processing',
          })
        );
        this.logger.info('Created new distribution run', {
          offeringId,
          periodId: period.id,
          runId: run.id
        });
      } catch (err) {
        const failure = classifyStellarRPCFailure(err, {
          operation: 'createDistributionRun',
          offeringId,
          periodId: period.id,
        });
        this.logger.error('Failed to create distribution run', {
          offeringId,
          periodId: period.id,
          error: err instanceof Error ? err.message : String(err),
          failureClass: failure.class
        });
        throw Errors.internal(`Failed to initialize distribution run: ${failure.class}`);
      }
    } else if (run.status !== 'processing') {
      try {
        await this.distributionRepo.updateRunStatus(run.id, 'processing');
      } catch (err) {
        const failure = classifyStellarRPCFailure(err, {
          operation: 'updateRunStatus',
          offeringId,
          periodId: period.id,
        });
        this.logger.error('Failed to update run status to processing', {
          offeringId,
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
          failureClass: failure.class
        });
        throw Errors.internal(`Failed to update distribution status: ${failure.class}`);
      }
    }

    this.logger.info('Distribution batch started', {
      offeringId,
      runId: run.id,
      period,
      revenueAmount,
      investorCount: balances.length,
      batchSize: this.batchSize,
    });

    // 6. Process payouts in batches with partial failure tracking
    const existingPayouts = await this.distributionRepo.getPayoutsForRun(run.id);
    const existingInvestorIds = new Set(existingPayouts.map((p: any) => p.investor_id));

    const successfulPayouts: Array<{ investor_id: string; amount: string }> = existingPayouts.map((p: any) => ({
      investor_id: p.investor_id,
      amount: p.amount,
    }));
    const failedPayouts: Array<{ investor_id: string; amount: string; error: string; errorClass?: string }> = [];
    let hasBatchFailure = false;

    for (let batchStart = 0; batchStart < rounded.length; batchStart += this.batchSize) {
      const batch = rounded.slice(batchStart, batchStart + this.batchSize);
      const batchNumber = Math.floor(batchStart / this.batchSize) + 1;

      try {
        for (const r of batch) {
          if (existingInvestorIds.has(r.investor_id)) {
            continue;
          }

          // Decimal with scale 2 toString() returns exactly 2 decimal places
          const amtStr = r.amount.toString();
          try {
            await this.withRetry(() =>
              this.distributionRepo.createPayout({
                distribution_run_id: run.id,
                investor_id: r.investor_id,
                amount: amtStr,
                status: 'pending',
              })
            );
            successfulPayouts.push({ investor_id: r.investor_id, amount: amtStr });
          } catch (err) {
            const failure = classifyStellarRPCFailure(err, {
              operation: 'createPayout',
              offeringId,
              periodId: period.id,
            });
            
            this.logger.error('Payout creation failed', {
              offeringId,
              runId: run.id,
              investorId: r.investor_id,
              errorClass: failure.class,
              batchNumber,
              // Log raw error internally but don't expose it in the result
              rawError: err instanceof Error ? err.message : String(err),
            });

            failedPayouts.push({
              investor_id: r.investor_id,
              amount: amtStr,
              error: `Action failed with ${failure.class}`,
              errorClass: failure.class,
            });
          }
        }
      } catch (err) {
        hasBatchFailure = true;
        const failure = classifyStellarRPCFailure(err, {
          operation: 'processBatch',
          offeringId,
          periodId: period.id,
        });
        this.logger.error('Payout batch failed', {
          offeringId,
          runId: run.id,
          batchNumber,
          errorClass: failure.class,
          investorCount: batch.length,
        });
      }
    }

    const duration = Date.now() - startTime;
    const finalStatus = (failedPayouts.length === 0 && !hasBatchFailure) ? 'completed' : 'failed';
    
    try {
      await this.distributionRepo.updateRunStatus(run.id, finalStatus);
      run.status = finalStatus;
    } catch (err) {
      const failure = classifyStellarRPCFailure(err, {
        operation: 'updateFinalRunStatus',
        offeringId,
        periodId: period.id,
      });
      this.logger.error('Failed to update final distribution run status', {
        offeringId,
        runId: run.id,
        finalStatus,
        error: err instanceof Error ? err.message : String(err),
        failureClass: failure.class
      });
    }

    this.logger.info('Distribution batch completed', {
      offeringId,
      runId: run.id,
      status: finalStatus,
      successfulPayouts: successfulPayouts.length,
      failedPayouts: failedPayouts.length,
      totalPayouts: rounded.length,
      duration,
    });

    return {
      distributionRun: run,
      successfulPayouts,
      failedPayouts,
      totalPayouts: rounded.length,
    };
  }

  /**
   * Internal helper to fetch balances from available sources
   */
  private async fetchBalances(offeringId: string, period: any): Promise<BalanceRow[]> {
    if (this.balanceProvider && typeof this.balanceProvider.getBalances === 'function') {
      return await this.balanceProvider.getBalances(offeringId, period.id);
    } else if (this.offeringRepo && typeof this.offeringRepo.getInvestors === 'function') {
      return await this.offeringRepo.getInvestors(offeringId, period);
    } else if (this.offeringRepo && typeof this.offeringRepo.listInvestors === 'function') {
      return await this.offeringRepo.listInvestors(offeringId, period);
    } else {
      throw new Error('No balance source available');
    }
  }

  /**
   * Executes a function with exponential backoff retry strategy.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempt - 1);
          if (this.logRetries) {
            this.logger.warn(`[DistributionEngine] Retry attempt ${attempt} failed, retrying in ${delay}ms...`);
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            if (timer.unref) timer.unref();
          });
        }
      }
    }
    throw lastError;
  }
}

export default DistributionEngine;
