import request from 'supertest';
import express, { Application } from 'express';
import { createRevenueRoutes } from './revenueRoutes';
import { RevenueService, RevenueReportInput } from '../services/revenueService';
import { AppError, ErrorCode } from '../lib/errors';
import { Logger } from '../lib/logger';
import { errorHandler } from '../middleware/errorHandler'; // Assuming global error handler

// Mock Logger
const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  critical: jest.fn(),
  alert: jest.fn(),
  emergency: jest.fn(),
  child: jest.fn(() => mockLogger),
};

// Mock RevenueService
const mockRevenueService = {
  ingestRevenueReport: jest.fn(),
};

describe('Revenue Routes', () => {
  let app: Application;

  beforeAll(() => {
    app = express();
    app.use(express.json()); // Body parser for JSON
    app.use('/api/v1', createRevenueRoutes(mockRevenueService as unknown as RevenueService, mockLogger));
    app.use(errorHandler); // Global error handler to catch AppErrors
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/offerings/:id/revenue', () => {
    const validOfferingId = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
    const validBody = {
      amount: '100.50',
      periodStart: '2023-01-01T00:00:00Z',
      periodEnd: '2023-01-31T23:59:59Z',
    };

    it('should return 202 for a valid revenue report', async () => {
      mockRevenueService.ingestRevenueReport.mockResolvedValue('stellar-tx-123');

      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(validBody);

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ message: 'Revenue report accepted for processing', transactionId: 'stellar-tx-123' });
      expect(mockRevenueService.ingestRevenueReport).toHaveBeenCalledWith({
        offeringId: validOfferingId,
        ...validBody,
      });
    });

    it('should return 400 for invalid offeringId format', async () => {
      const invalidOfferingId = 'not-a-uuid';
      const res = await request(app)
        .post(`/api/v1/offerings/${invalidOfferingId}/revenue`)
        .send(validBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['params.id: invalid format'],
        })
      );
      expect(mockRevenueService.ingestRevenueReport).not.toHaveBeenCalled();
    });

    it('should return 400 for missing amount', async () => {
      const invalidBody = { ...validBody, amount: undefined };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.amount: required'],
        })
      );
    });

    it('should return 400 for invalid amount format', async () => {
      const invalidBody = { ...validBody, amount: 'invalid' };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.amount: invalid format'],
        })
      );
    });

    it('should return 400 for amount with too many decimal places (>18)', async () => {
      const invalidBody = { ...validBody, amount: '1.1234567890123456789' };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.amount: invalid format'],
        })
      );
    });

    it('should return 400 for missing periodStart', async () => {
      const invalidBody = { ...validBody, periodStart: undefined };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.periodStart: required'],
        })
      );
    });

    it('should return 400 for invalid periodStart format', async () => {
      const invalidBody = { ...validBody, periodStart: 'not-a-date' };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.periodStart: invalid format'],
        })
      );
    });

    it('should return 400 for missing periodEnd', async () => {
      const invalidBody = { ...validBody, periodEnd: undefined };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.periodEnd: required'],
        })
      );
    });

    it('should return 400 for invalid periodEnd format', async () => {
      const invalidBody = { ...validBody, periodEnd: 'not-a-date' };
      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.periodEnd: invalid format'],
        })
      );
    });

    it('should return 400 if RevenueService throws a validation error', async () => {
      mockRevenueService.ingestRevenueReport.mockRejectedValue(
        new AppError(ErrorCode.VALIDATION_ERROR, 'Revenue amount must be positive.', 400)
      );

      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(validBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Revenue amount must be positive.',
        })
      );
    });

    it('should return 500 if RevenueService throws an internal error', async () => {
      mockRevenueService.ingestRevenueReport.mockRejectedValue(
        new AppError(ErrorCode.INTERNAL_ERROR, 'Something went wrong.', 500)
      );

      const res = await request(app)
        .post(`/api/v1/offerings/${validOfferingId}/revenue`)
        .send(validBody);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual(
        expect.objectContaining({
          code: ErrorCode.INTERNAL_ERROR,
          message: 'Internal server error', // Global error handler sanitizes
        })
      );
    });
  });

  describe('POST /api/v1/revenue-reports', () => {
    const validOfferingId = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
    const validBody = {
      offeringId: validOfferingId,
      amount: '100.50',
      periodStart: '2023-01-01T00:00:00Z',
      periodEnd: '2023-01-31T23:59:59Z',
    };

    it('should return 202 for a valid revenue report with offeringId in body', async () => {
      mockRevenueService.ingestRevenueReport.mockResolvedValue('stellar-tx-456');

      const res = await request(app)
        .post(`/api/v1/revenue-reports`)
        .send(validBody);

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ message: 'Revenue report accepted for processing', transactionId: 'stellar-tx-456' });
      expect(mockRevenueService.ingestRevenueReport).toHaveBeenCalledWith(validBody);
    });

    it('should return 400 for missing offeringId in body', async () => {
      const invalidBody = { ...validBody, offeringId: undefined };
      const res = await request(app)
        .post(`/api/v1/revenue-reports`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.offeringId: required'],
        })
      );
    });

    it('should return 400 for invalid offeringId format in body', async () => {
      const invalidBody = { ...validBody, offeringId: 'not-a-uuid' };
      const res = await request(app)
        .post(`/api/v1/revenue-reports`)
        .send(invalidBody);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'ValidationError',
          details: ['body.offeringId: invalid format'],
        })
      );
    });
  });
});