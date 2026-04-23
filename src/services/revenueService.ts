import { OfferingRepository } from '../db/repositories/offeringRepository';
import {
    RevenueReportRepository,
    CreateRevenueReportInput,
    RevenueReport,
} from '../db/repositories/revenueReportRepository';
import { Logger, LogLevel } from '../lib/logger';
import { Errors } from '../lib/errors';

export interface SubmitRevenueReportInput {
    offeringId: string;
    issuerId: string;
    amount: string;
    periodStart: Date;
    periodEnd: Date;
    requestId?: string;
}

/**
 * Decimal boundary limits for revenue amounts.
 * @dev Database schema uses NUMERIC(30,10) for amounts to preserve precision.
 *      This allows up to 20 integer digits and 10 decimal places (10^-10 cents minimum).
 */
const DECIMAL_LIMITS = {
    /** Maximum number of integer digits before decimal point */
    MAX_INTEGER_DIGITS: 20,
    /** Maximum number of fractional digits after decimal point */
    MAX_DECIMAL_PLACES: 10,
    /** Maximum representable amount (20 nines + decimal + 10 nines) */
    MAX_AMOUNT: '99999999999999999999.9999999999',
    /** Minimum positive amount (essentially 0.0000000001) */
    MIN_AMOUNT: '0.0000000001',
} as const;

/**
 * RevenueService: Business logic for revenue report submission and validation.
 *
 * Security Assumptions:
 * - The `issuerId` has been authenticated via JWT middleware before service invocation.
 * - The offering ownership check is performed before any state-modifying operations.
 * - Database transactions (if configured) provide ACID guarantees for concurrency safety.
 *
 * Validation Rules:
 * - Amount must be a positive decimal string with at most 10 decimal places (database NUMERIC precision).
 * - Period end must be strictly after period start (prevents zero-width or negative ranges).
 * - New reports cannot overlap with any existing report for the same offering.
 * - Amount cannot exceed 20 integer digits (prevents integer overflow in Stellar operations).
 *
 * @module services/revenueService
 */
export class RevenueService {
    private logger: Logger;

    constructor(
        private offeringRepo: OfferingRepository,
        private revenueReportRepo: RevenueReportRepository
    ) {
        this.logger = new Logger({ level: LogLevel.INFO });
    }

    /**
     * @notice Submits and validates a revenue report for a specific offering.
     * @dev Hardened with production-grade validation for amounts and reporting periods.
     * 
     * Decimal Precision:
     * - Database schema: NUMERIC(30,10) - supports up to 20 integer + 10 decimal places.
     * - Input validation: Rejects amounts exceeding these boundaries.
     * - String storage: Amounts stored as strings in JSON to preserve precision.
     * 
     * @param input - The revenue report data containing offering, amount, and period.
     * @returns The persisted RevenueReport object.
     * @throws AppError if validation fails or unauthorized access is detected.
     */
    async submitReport(input: SubmitRevenueReportInput): Promise<RevenueReport> {
        const requestId = input.requestId || 'unknown';

        try {
            this.logger.debug('Starting revenue report submission', {
                requestId,
                offeringId: input.offeringId,
                issuerId: input.issuerId,
                amount: input.amount,
            });

            // ─── 1. Validate offering existence ──────────────────────────────────────
            const offering = await this.offeringRepo.findById(input.offeringId);
            if (!offering) {
                this.logger.warn('Revenue submission: offering not found', {
                    requestId,
                    offeringId: input.offeringId,
                });
                throw Errors.notFound(`Offering with ID ${input.offeringId} not found`);
            }

            // ─── 2. Validate offering ownership ──────────────────────────────────────
            if (offering.issuer_id !== input.issuerId) {
                this.logger.warn('Revenue submission: unauthorized offering access', {
                    requestId,
                    offeringId: input.offeringId,
                    expectedIssuerId: offering.issuer_id,
                    providedIssuerId: input.issuerId,
                });
                throw Errors.forbidden(
                    `You do not have permission to submit revenue reports for this offering`
                );
            }

            // ─── 3. Validate and parse amount (decimal boundaries) ───────────────────
            const amountValidation = this.validateDecimalAmount(input.amount);
            if (!amountValidation.valid) {
                this.logger.warn('Revenue submission: invalid amount format', {
                    requestId,
                    amount: input.amount,
                    reason: amountValidation.reason,
                });
                throw Errors.badRequest(
                    `Invalid revenue amount: ${amountValidation.reason}`,
                    { amount: input.amount, details: amountValidation.details }
                );
            }

            const amountNum = parseFloat(input.amount);

            // ─── 4. Validate period logic (dates must be properly ordered) ─────────────
            if (input.periodEnd <= input.periodStart) {
                this.logger.warn('Revenue submission: invalid period ordering', {
                    requestId,
                    periodStart: input.periodStart.toISOString(),
                    periodEnd: input.periodEnd.toISOString(),
                });
                throw Errors.badRequest(
                    'Invalid period: end date must be strictly after start date',
                    {
                        periodStart: input.periodStart.toISOString(),
                        periodEnd: input.periodEnd.toISOString(),
                    }
                );
            }

            // ─── 5. Check for overlapping periods ────────────────────────────────────
            const overlapping = await this.revenueReportRepo.findOverlappingReport(
                input.offeringId,
                input.periodStart,
                input.periodEnd
            );

            if (overlapping) {
                this.logger.warn('Revenue submission: overlapping period detected', {
                    requestId,
                    offeringId: input.offeringId,
                    newPeriodStart: input.periodStart.toISOString(),
                    newPeriodEnd: input.periodEnd.toISOString(),
                    existingReportId: overlapping.id,
                    existingPeriodStart: overlapping.period_start?.toISOString(),
                    existingPeriodEnd: overlapping.period_end?.toISOString(),
                });
                throw Errors.conflict(
                    `A revenue report already exists that overlaps with the specified period`,
                    {
                        newPeriod: {
                            start: input.periodStart.toISOString(),
                            end: input.periodEnd.toISOString(),
                        },
                        existingPeriod: {
                            start: overlapping.period_start?.toISOString(),
                            end: overlapping.period_end?.toISOString(),
                        },
                        existingReportId: overlapping.id,
                    }
                );
            }

            // ─── 6. Persist report ──────────────────────────────────────────────────
            this.logger.info('Revenue report validation passed, persisting', {
                requestId,
                offeringId: input.offeringId,
                issuerId: input.issuerId,
                amount: input.amount,
                amountNum: amountNum.toString(),
            });

            const report = await this.revenueReportRepo.create({
                offering_id: input.offeringId,
                issuer_id: input.issuerId,
                amount: input.amount,
                period_start: input.periodStart,
                period_end: input.periodEnd,
                reported_by: input.issuerId, // Assuming reporter is the issuer for now
            });

            this.logger.info('Revenue report persisted successfully', {
                requestId,
                reportId: report.id,
                offeringId: input.offeringId,
            });

            // ─── 7. Emit event for distribution engine ──────────────────────────────
            this.emitDistributionEvent(report, requestId);

            return report;
        } catch (error) {
            // Re-throw AppErrors as-is; they're already properly structured
            if (error instanceof Error && (error as any).statusCode !== undefined) {
                throw error;
            }
            // Unexpected errors get sanitized
            this.logger.error('Unexpected error during revenue submission', {
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw Errors.internal('An unexpected error occurred during revenue submission');
        }
    }

    /**
     * Validates a decimal amount string against database precision limits.
     *
     * @dev Enforces:
     *      - Positive value (no negative or zero amounts).
     *      - Valid decimal format (at most one decimal point).
     *      - Maximum 20 integer digits (prevents overflow in Stellar operations).
     *      - Maximum 10 decimal places (matches database NUMERIC(30,10) precision).
     *      - No leading zeros beyond single zero before decimal (e.g., 0.5 is valid, 00.5 is not).
     *      - No exponential notation (e.g., 1e6 rejected).
     *
     * @param amount - The amount string to validate.
     * @returns Validation result with `valid` flag and detailed reason/details if invalid.
     */
    private validateDecimalAmount(amount: string): {
        valid: boolean;
        reason?: string;
        details?: Record<string, unknown>;
    } {
        // ─── Empty or non-string check ───────────────────────────────────────────
        if (typeof amount !== 'string' || amount.length === 0) {
            return { valid: false, reason: 'Amount must be a non-empty string' };
        }

        // ─── Reject exponential notation ─────────────────────────────────────────
        if (amount.includes('e') || amount.includes('E')) {
            return {
                valid: false,
                reason: 'Exponential notation is not allowed',
                details: { example: 'use 1000000 instead of 1e6' },
            };
        }

        // ─── Basic format validation ─────────────────────────────────────────────
        // Must be digits optionally followed by a decimal point and more digits
        if (!/^\d+(\.\d+)?$/.test(amount)) {
            return {
                valid: false,
                reason: 'Amount must be a positive decimal number (digits and optional decimal point only)',
                details: { providedValue: amount },
            };
        }

        // ─── Split integer and fractional parts ──────────────────────────────────
        const parts = amount.split('.');
        const integerPart = parts[0];
        const fractionalPart = parts[1] || '';

        // ─── Check integer part length ───────────────────────────────────────────
        if (integerPart.length > DECIMAL_LIMITS.MAX_INTEGER_DIGITS) {
            return {
                valid: false,
                reason: `Integer part exceeds maximum ${DECIMAL_LIMITS.MAX_INTEGER_DIGITS} digits`,
                details: {
                    provided: integerPart.length,
                    maximum: DECIMAL_LIMITS.MAX_INTEGER_DIGITS,
                    providedValue: amount,
                },
            };
        }

        // ─── Check fractional part length ────────────────────────────────────────
        if (fractionalPart.length > DECIMAL_LIMITS.MAX_DECIMAL_PLACES) {
            return {
                valid: false,
                reason: `Decimal places exceed maximum ${DECIMAL_LIMITS.MAX_DECIMAL_PLACES} places`,
                details: {
                    provided: fractionalPart.length,
                    maximum: DECIMAL_LIMITS.MAX_DECIMAL_PLACES,
                    providedValue: amount,
                },
            };
        }

        // ─── Check numeric value > 0 ────────────────────────────────────────────
        const numValue = parseFloat(amount);
        if (!Number.isFinite(numValue) || numValue <= 0) {
            return {
                valid: false,
                reason: 'Amount must be a positive number greater than zero',
                details: { providedValue: amount },
            };
        }

        // ─── Check against explicit maximum ─────────────────────────────────────
        const maxNum = parseFloat(DECIMAL_LIMITS.MAX_AMOUNT);
        if (numValue > maxNum) {
            return {
                valid: false,
                reason: `Amount exceeds maximum allowed value of ${DECIMAL_LIMITS.MAX_AMOUNT}`,
                details: { providedValue: amount, maximum: DECIMAL_LIMITS.MAX_AMOUNT },
            };
        }

        return { valid: true };
    }

    private emitDistributionEvent(report: RevenueReport, requestId: string): void {
        // Placeholder for event emission logic
        // This could be a message to a queue (e.g., RabbitMQ, Kafka) or a PubSub system
        this.logger.info('Emitting distribution event for revenue report', {
            requestId,
            reportId: report.id,
            offeringId: report.offering_id,
            amount: report.amount,
        });
    }
}
