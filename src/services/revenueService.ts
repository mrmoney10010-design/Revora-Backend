import { AppError, ErrorCode } from '../lib/errors';
import { Decimal } from '../lib/decimal';
import { Logger } from '../lib/logger'; // Assuming a logger exists

/**
 * @title Revenue Service
 * @notice Handles the ingestion and processing of revenue reports,
 *         ensuring decimal string invariants match Soroban i128 requirements.
 * @dev This service uses the Decimal utility for precise arithmetic and
 *      converts amounts to a Soroban-compatible i128 format before
 *      interacting with the Stellar network.
 *
 * Security Assumptions:
 * - All incoming `amount` strings are strictly validated for format and precision.
 * - Financial calculations use `Decimal` (BigInt-based) to prevent floating-point errors.
 * - Amounts are checked against Soroban i128 limits before submission to prevent overflows.
 * - All errors are caught and re-thrown as structured `AppError` instances,
 *   preventing sensitive internal details from being exposed to clients.
 * - Stellar RPC failures are classified and handled gracefully, avoiding information leakage.
 */

// Assuming a default scale for Soroban i128 for revenue amounts, e.g., 7 for native assets.
// This should ideally be configurable per asset or offering.
const SOROBAN_I128_SCALE = 7;

export interface RevenueReportInput {
  offeringId: string;
  amount: string; // Decimal string, e.g., "123.45"
  periodStart: string; // ISO 8601 date or datetime string
  periodEnd: string; // ISO 8601 date or datetime string
}

// Mock StellarService interface for dependency injection
interface StellarService {
  submitRevenueToSoroban(offeringId: string, amountI128: BigInt, periodStart: Date, periodEnd: Date): Promise<string>;
}

// Mock RevenueRepository interface for dependency injection
interface RevenueRepository {
  saveRevenueReport(report: RevenueReportInput & { amountI128: BigInt }): Promise<any>;
}

export class RevenueService {
  private readonly stellarService: StellarService;
  private readonly revenueRepository: RevenueRepository;
  private readonly logger: Logger;

  constructor(stellarService: StellarService, revenueRepository: RevenueRepository, logger: Logger) {
    this.stellarService = stellarService;
    this.revenueRepository = revenueRepository;
    this.logger = logger;
  }

  /**
   * Processes a revenue report, validates inputs, converts amount to Soroban i128,
   * and submits it to the Stellar network and persists it.
   * @param input The revenue report data.
   * @returns A promise that resolves with the result of the operation (e.g., transaction ID).
   * @throws {AppError} for validation, conversion, or business logic errors.
   */
  async ingestRevenueReport(input: RevenueReportInput): Promise<string> {
    const { offeringId, amount, periodStart, periodEnd } = input;

    // 1. Validate and parse amount using Decimal utility
    let decimalAmount: Decimal;
    try {
      decimalAmount = new Decimal(amount);
      if (decimalAmount.isZero()) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          'Revenue amount must be positive.',
          400,
          { field: 'amount', value: amount }
        );
      }
    } catch (error) {
      this.logger.warn('Invalid revenue amount format', { offeringId, amount, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid revenue amount: ${amount}`,
        400,
        { field: 'amount', value: amount }
      );
    }

    // 2. Validate period dates
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid date format for periodStart or periodEnd. Must be ISO 8601.',
        400,
        { periodStart, periodEnd }
      );
    }

    if (startDate >= endDate) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'periodEnd must be after periodStart.',
        400,
        { periodStart, periodEnd }
      );
    }

    // 3. Convert amount to Soroban i128 scaled BigInt
    let amountI128: BigInt;
    try {
      amountI128 = decimalAmount.toSorobanI128(SOROBAN_I128_SCALE);
    } catch (error) {
      this.logger.error('Failed to convert decimal amount to Soroban i128', { offeringId, amount, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Failed to process revenue amount for Soroban.',
        500,
        { offeringId, amount }
      );
    }

    // 4. Submit to Stellar/Soroban
    let transactionId: string;
    try {
      transactionId = await this.stellarService.submitRevenueToSoroban(
        offeringId,
        amountI128,
        startDate,
        endDate
      );
      this.logger.info('Revenue submitted to Soroban', { offeringId, amount, amountI128: amountI128.toString(), transactionId });
    } catch (error) {
      this.logger.error('Stellar RPC submission failed', { offeringId, amount, error: error instanceof Error ? error.message : String(error) });
      // Use a utility to classify Stellar RPC failures into AppErrors
      throw this.classifyStellarRPCFailure(error);
    }

    // 5. Persist revenue report
    try {
      await this.revenueRepository.saveRevenueReport({
        ...input,
        amountI128,
      });
      this.logger.info('Revenue report saved', { offeringId, transactionId });
    } catch (error) {
      this.logger.error('Failed to save revenue report to database', { offeringId, amount, transactionId, error: error instanceof Error ? error.message : String(error) });
      // This is a critical failure as Stellar transaction might have gone through but DB save failed.
      // Depending on business logic, this might require a rollback on Stellar or manual reconciliation.
      // For now, we'll just report an internal error.
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Revenue report submitted but failed to save internally. Manual reconciliation may be required.',
        500,
        { offeringId, transactionId }
      );
    }

    return transactionId;
  }

  /**
   * @dev Classifies Stellar RPC errors into structured AppErrors.
   * This function acts as a security boundary, preventing raw Stellar error messages
   * from being exposed to the client. It maps known RPC error codes/messages
   * to generic, client-safe AppError codes.
   *
   * @param error The raw error object received from the Stellar RPC client.
   * @returns An AppError instance.
   */
  private classifyStellarRPCFailure(error: unknown): AppError {
    // Example classification logic. This would be much more detailed in a real implementation.
    if (error && typeof error === 'object' && 'response' in error && typeof error.response === 'object' && error.response !== null && 'status' in error.response) {
      const status = (error.response as any).status;
      const data = (error.response as any).data; // Horizon error details

      if (status === 400) {
        // Bad Request from Horizon, e.g., malformed transaction, invalid arguments
        this.logger.warn('Stellar RPC Bad Request', { error, data });
        return new AppError(
          ErrorCode.BAD_REQUEST,
          'Stellar transaction failed due to invalid request parameters.',
          400,
          { stellarError: data?.extras?.result_codes?.transaction }
        );
      }
      if (status === 404) {
        // Not Found, e.g., account not found
        this.logger.warn('Stellar RPC Not Found', { error, data });
        return new AppError(
          ErrorCode.NOT_FOUND,
          'Required Stellar resource not found (e.g., account).',
          404,
          { stellarError: data?.extras?.result_codes?.transaction }
        );
      }
      if (status >= 500) {
        // Internal Server Error from Horizon
        this.logger.error('Stellar RPC Internal Error', { error, data });
        return new AppError(
          ErrorCode.SERVICE_UNAVAILABLE,
          'Stellar network is currently unavailable or experiencing issues.',
          503,
          { stellarError: data?.extras?.result_codes?.transaction }
        );
      }
    }

    // Generic fallback for unclassified errors
    this.logger.error('Unclassified Stellar RPC error', { error });
    return new AppError(
      ErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred while interacting with the Stellar network.',
      500
    );
  }
}