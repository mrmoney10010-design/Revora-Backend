import { RevenueService, SubmitRevenueReportInput } from './revenueService';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { AppError } from '../lib/errors';

describe('RevenueService', () => {
    let service: RevenueService;
    let mockOfferingRepo: jest.Mocked<OfferingRepository>;
    let mockRevenueReportRepo: jest.Mocked<RevenueReportRepository>;

    beforeEach(() => {
        mockOfferingRepo = {
            findById: jest.fn(),
            isOwner: jest.fn(),
        } as any;

        mockRevenueReportRepo = {
            create: jest.fn(),
            findOverlappingReport: jest.fn(),
        } as any;

        service = new RevenueService(mockOfferingRepo, mockRevenueReportRepo);
    });

    describe('Happy path: successful report submission', () => {
        it('should successfully submit a revenue report with valid inputs', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                issuerId: 'issuer-1',
                amount: '1000.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
                requestId: 'req-123',
            };

            mockOfferingRepo.findById.mockResolvedValue({
                id: input.offeringId,
                issuer_id: input.issuerId,
                name: 'Test Offering',
                symbol: 'TEST',
                status: 'active',
                created_at: new Date(),
                updated_at: new Date(),
            } as any);

            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({
                id: 'report-1',
                offering_id: input.offeringId,
                issuer_id: input.issuerId,
                amount: input.amount,
                period_start: input.periodStart,
                period_end: input.periodEnd,
                created_at: new Date(),
                updated_at: new Date(),
            } as any);

            const result = await service.submitReport(input);

            expect(result.id).toBe('report-1');
            expect(result.amount).toBe('1000.00');
            expect(mockOfferingRepo.findById).toHaveBeenCalledWith(input.offeringId);
            expect(mockRevenueReportRepo.create).toHaveBeenCalled();
            expect(mockRevenueReportRepo.findOverlappingReport).toHaveBeenCalled();
        });

        it('should submit report with minimal decimal places', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                issuerId: 'issuer-1',
                amount: '100',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockOfferingRepo.findById.mockResolvedValue({
                id: input.offeringId,
                issuer_id: input.issuerId,
            } as any);
            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({
                id: 'report-1',
                amount: input.amount,
            } as any);

            const result = await service.submitReport(input);
            expect(result.amount).toBe('100');
        });
    });

    describe('Offering validation', () => {
        it('should reject submission if offering not found', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                issuerId: 'issuer-1',
                amount: '1000.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockOfferingRepo.findById.mockResolvedValue(null);

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
            await expect(service.submitReport(input)).rejects.toMatchObject({
                statusCode: 404,
                code: 'NOT_FOUND',
            });
        });

        it('should reject submission if issuer does not own offering', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                issuerId: 'issuer-wrong',
                amount: '1000.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockOfferingRepo.findById.mockResolvedValue({
                id: input.offeringId,
                issuer_id: 'issuer-correct',
            } as any);

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
            await expect(service.submitReport(input)).rejects.toMatchObject({
                statusCode: 403,
                code: 'FORBIDDEN',
            });
        });
    });

    describe('Decimal amount validation: format and boundaries', () => {
        beforeEach(() => {
            mockOfferingRepo.findById.mockResolvedValue({
                id: 'offering-1',
                issuer_id: 'issuer-1',
            } as any);
        });

        // ─── Valid decimal amounts ────────────────────────────────────────────
        it('should accept amount with exactly 10 decimal places', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.1234567890', // Exactly 10 decimal places
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            const result = await service.submitReport(input);
            expect(result.id).toBe('report-1');
        });

        it('should accept amount with fewer than 10 decimal places', async () => {
            const amounts = ['1.5', '1.12', '1.123', '1.1234567'];
            for (const amount of amounts) {
                mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
                mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

                const input: SubmitRevenueReportInput = {
                    offeringId: 'offering-1',
                    issuerId: 'issuer-1',
                    amount,
                    periodStart: new Date('2024-01-01'),
                    periodEnd: new Date('2024-01-31'),
                };

                await expect(service.submitReport(input)).resolves.toBeDefined();
            }
        });

        // ─── Invalid: exceeding decimal places ────────────────────────────────
        it('should reject amount with more than 10 decimal places', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.12345678901', // 11 decimal places
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
            await expect(service.submitReport(input)).rejects.toMatchObject({
                statusCode: 400,
                code: 'BAD_REQUEST',
            });
        });

        // ─── Invalid: integer part exceeds 20 digits ────────────────────────
        it('should reject amount with more than 20 integer digits', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '123456789012345678901', // 21 digits
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
            await expect(service.submitReport(input)).rejects.toMatchObject({
                code: 'BAD_REQUEST',
            });
        });

        // ─── Invalid: non-positive amounts ────────────────────────────────────
        it('should reject zero amount', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '0',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
        });

        it('should reject negative amount', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '-100.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
        });

        // ─── Invalid: format violations ───────────────────────────────────────
        it('should reject non-numeric characters', async () => {
            const invalidAmounts = [
                'abc',
                '100.00a',
                '100 00',
                '$100',
                '100,000',
                '1e6',
                '1E3',
            ];

            for (const amount of invalidAmounts) {
                const input: SubmitRevenueReportInput = {
                    offeringId: 'offering-1',
                    issuerId: 'issuer-1',
                    amount,
                    periodStart: new Date('2024-01-01'),
                    periodEnd: new Date('2024-01-31'),
                };

                await expect(service.submitReport(input)).rejects.toThrow(AppError);
            }
        });

        it('should reject multiple decimal points', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.50.25',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
        });

        it('should reject exponential notation', async () => {
            const exponentialAmounts = ['1e6', '1E6', '1.5e3', '1.5E3'];
            for (const amount of exponentialAmounts) {
                const input: SubmitRevenueReportInput = {
                    offeringId: 'offering-1',
                    issuerId: 'issuer-1',
                    amount,
                    periodStart: new Date('2024-01-01'),
                    periodEnd: new Date('2024-01-31'),
                };

                await expect(service.submitReport(input)).rejects.toThrow(AppError);
            }
        });

        it('should reject empty string amount', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
        });
    });

    describe('Period validation', () => {
        beforeEach(() => {
            mockOfferingRepo.findById.mockResolvedValue({
                id: 'offering-1',
                issuer_id: 'issuer-1',
            } as any);
        });

        it('should reject if period end equals period start', async () => {
            const sameDate = new Date('2024-01-15');
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: sameDate,
                periodEnd: sameDate,
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
            await expect(service.submitReport(input)).rejects.toMatchObject({
                statusCode: 400,
                code: 'BAD_REQUEST',
            });
        });

        it('should reject if period end is before period start', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-31'),
                periodEnd: new Date('2024-01-01'),
            };

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
        });

        it('should accept valid period ordering', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-01T00:00:00Z'),
                periodEnd: new Date('2024-01-01T00:00:01Z'), // 1 second later
            };

            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            await expect(service.submitReport(input)).resolves.toBeDefined();
        });
    });

    describe('Period overlap detection', () => {
        beforeEach(() => {
            mockOfferingRepo.findById.mockResolvedValue({
                id: 'offering-1',
                issuer_id: 'issuer-1',
            } as any);
        });

        it('should reject if new period overlaps with existing report', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-10'),
                periodEnd: new Date('2024-01-20'),
            };

            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue({
                id: 'existing-report',
                offering_id: 'offering-1',
                period_start: new Date('2024-01-15'),
                period_end: new Date('2024-01-25'),
            } as any);

            await expect(service.submitReport(input)).rejects.toThrow(AppError);
            await expect(service.submitReport(input)).rejects.toMatchObject({
                statusCode: 409,
                code: 'CONFLICT',
            });
        });

        it('should accept if no overlapping periods exist', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-10'),
            };

            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            const result = await service.submitReport(input);
            expect(result.id).toBe('report-1');
        });

        it('should check for overlaps with correct arguments', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            await service.submitReport(input);

            expect(mockRevenueReportRepo.findOverlappingReport).toHaveBeenCalledWith(
                'offering-1',
                input.periodStart,
                input.periodEnd
            );
        });
    });

    describe('Edge cases and boundary values', () => {
        beforeEach(() => {
            mockOfferingRepo.findById.mockResolvedValue({
                id: 'offering-1',
                issuer_id: 'issuer-1',
            } as any);
            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
        });

        it('should handle very large amounts within limits', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '99999999999999999999.9999999999', // Maximum valid amount
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            const result = await service.submitReport(input);
            expect(result.id).toBe('report-1');
        });

        it('should handle very small amounts within limits', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '0.0000000001', // Minimum positive amount
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            const result = await service.submitReport(input);
            expect(result.id).toBe('report-1');
        });

        it('should preserve exact decimal string in report', async () => {
            const amount = '1234.5678901234'; // Note: more than 10 decimals should fail before this
            // Let's use a valid one instead
            const validAmount = '1234.1234567890';
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: validAmount,
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
            };

            mockRevenueReportRepo.create.mockResolvedValue({
                id: 'report-1',
                amount: validAmount,
            } as any);

            const result = await service.submitReport(input);
            expect(result.amount).toBe(validAmount);
        });
    });

    describe('Request ID propagation and logging', () => {
        beforeEach(() => {
            mockOfferingRepo.findById.mockResolvedValue({
                id: 'offering-1',
                issuer_id: 'issuer-1',
            } as any);
            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
        });

        it('should accept and use requestId from input', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
                requestId: 'req-custom-123',
            };

            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            const result = await service.submitReport(input);
            expect(result.id).toBe('report-1');
            // RequestId is logged but not returned in the report
        });

        it('should work without requestId (defaults to unknown)', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '100.00',
                periodStart: new Date('2024-01-01'),
                periodEnd: new Date('2024-01-31'),
                // No requestId provided
            };

            mockRevenueReportRepo.create.mockResolvedValue({ id: 'report-1' } as any);

            const result = await service.submitReport(input);
            expect(result.id).toBe('report-1');
        });
    });

    describe('Data persistence', () => {
        it('should pass correct data to repository.create()', async () => {
            const input: SubmitRevenueReportInput = {
                offeringId: 'offering-1',
                issuerId: 'issuer-1',
                amount: '500.123',
                periodStart: new Date('2024-02-01'),
                periodEnd: new Date('2024-02-28'),
            };

            mockOfferingRepo.findById.mockResolvedValue({
                id: 'offering-1',
                issuer_id: 'issuer-1',
            } as any);
            mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
            mockRevenueReportRepo.create.mockResolvedValue({
                id: 'report-1',
                amount: input.amount,
            } as any);

            await service.submitReport(input);

            expect(mockRevenueReportRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    offering_id: input.offeringId,
                    issuer_id: input.issuerId,
                    amount: input.amount,
                    period_start: input.periodStart,
                    period_end: input.periodEnd,
                    reported_by: input.issuerId,
                })
            );
        });
    });
});
