import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarSubmissionService } from './stellarSubmissionService';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';

// Mock logger
jest.mock('../lib/logger', () => ({
  globalLogger: {
    warn: jest.fn(),
  },
}));

const mockTransaction = {
  hash: () => 'mock-transaction-hash',
  sign: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  return {
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn().mockResolvedValue({
          accountId: () => 'G-MOCK-PUBLIC-KEY',
          sequenceNumber: () => '1',
          incrementSequenceNumber: jest.fn(),
        }),
        sendTransaction: jest
          .fn()
          .mockResolvedValue({ 
            hash: 'mock-hash', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          }),
      })),
    },
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: () => 'G-MOCK-PUBLIC-KEY',
        sign: jest.fn(),
      }),
    },
    Asset: {
      native: jest.fn().mockReturnValue({ code: 'XLM', issuer: undefined }),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue(mockTransaction),
    })),
    Operation: {
      payment: jest.fn(),
      invokeContractFunction: jest.fn(),
    },
    BASE_FEE: '100',
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; October 2015',
    },
  };
});

// Mock environment
jest.mock('../config/env', () => ({
  env: {
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  },
}));

describe('StellarSubmissionService', () => {
  let service: StellarSubmissionService;
  let mockServer: jest.Mocked<StellarSdk.rpc.Server>;
  const mockSecret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  beforeEach(() => {
    process.env.STELLAR_SERVER_SECRET = mockSecret;
    jest.clearAllMocks();
    service = new StellarSubmissionService();
    mockServer = (StellarSdk.rpc.Server as jest.Mock).mock.results[0].value;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should initialize with the correct horizon URL and keypair', () => {
    expect(StellarSdk.Keypair.fromSecret).toHaveBeenCalledWith(mockSecret);
    expect(StellarSdk.rpc.Server).toHaveBeenCalled();
  });

  it('should throw error if secret is missing', () => {
    const originalSecret = process.env.STELLAR_SERVER_SECRET;
    delete process.env.STELLAR_SERVER_SECRET;
    expect(() => new StellarSubmissionService()).toThrow(
      'STELLAR_SERVER_SECRET is not defined in environment variables',
    );
    process.env.STELLAR_SERVER_SECRET = originalSecret;
  });

  it('should submit a payment successfully', async () => {
    const to = 'G-DESTINATION';
    const amount = '10.0';

    const result = await service.submitPayment(to, amount);

    expect(result).toEqual({ hash: 'mock-hash', status: 'PENDING' });
    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
      destination: to,
      amount,
      asset: expect.anything(),
    });
    expect(StellarSdk.TransactionBuilder).toHaveBeenCalled();
  });

  it('should return the public key', () => {
    expect(service.getPublicKey()).toBe('G-MOCK-PUBLIC-KEY');
  });

  describe('Enhanced Error Handling', () => {
    describe('submitPayment error scenarios', () => {
      it('should handle insufficient funds error', async () => {
        const insufficientError = { code: 'INSUFFICIENT_FUNDS' };
        mockServer.sendTransaction.mockRejectedValue(insufficientError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'Insufficient funds for payment',
        });

        expect(logger.warn).toHaveBeenCalledWith(
          'Stellar RPC operation failed',
          expect.objectContaining({
            failureClass: 'INSUFFICIENT_FUNDS',
            operation: 'submit_payment',
          })
        );
      });

      it('should handle validation error', async () => {
        const validationError = { status: 400 };
        mockServer.sendTransaction.mockRejectedValue(validationError);

        await expect(service.submitPayment('invalid', 'invalid')).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          message: 'Invalid payment parameters',
        });

        expect(logger.warn).toHaveBeenCalled();
      });

      it('should handle timeout error with retry', async () => {
        jest.useFakeTimers();
        const timeoutError = new Error('Request timeout');
        timeoutError.name = 'AbortError';
        
        mockServer.sendTransaction
          .mockRejectedValueOnce(timeoutError)
          .mockRejectedValueOnce(timeoutError)
          .mockResolvedValueOnce({ 
            hash: 'retry-hash', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });

        const promise = service.submitPayment('G-DEST', '10.0');
        
        // First retry
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        
        // Second retry
        jest.advanceTimersByTime(2000);
        await Promise.resolve();

        const result = await promise;
        expect(result.hash).toBe('retry-hash');
        expect(logger.warn).toHaveBeenCalledTimes(2);
      });

      it('should handle rate limit error', async () => {
        const rateLimitError = { status: 429, response: { headers: { 'retry-after': '60' } } };
        mockServer.sendTransaction.mockRejectedValue(rateLimitError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Stellar network rate limit exceeded',
        });

        expect(logger.warn).toHaveBeenCalledWith(
          'Stellar RPC operation failed',
          expect.objectContaining({
            failureClass: 'RATE_LIMIT',
          })
        );
      });

      it('should handle network error', async () => {
        const networkError = new Error('Network connection failed');
        networkError.name = 'NetworkError';
        mockServer.sendTransaction.mockRejectedValue(networkError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Network connection to Stellar failed',
        });
      });

      it('should handle unauthorized error', async () => {
        const unauthorizedError = { status: 401 };
        mockServer.sendTransaction.mockRejectedValue(unauthorizedError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
          message: 'Authentication with Stellar network failed',
        });
      });

      it('should handle transaction failed error', async () => {
        const txFailedError = { code: 'TRANSACTION_FAILED' };
        mockServer.sendTransaction.mockRejectedValue(txFailedError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'Stellar transaction failed',
        });
      });

      it('should handle bad sequence error with retry', async () => {
        jest.useFakeTimers();
        const badSeqError = { code: 'BAD_SEQUENCE' };
        
        mockServer.sendTransaction
          .mockRejectedValueOnce(badSeqError)
          .mockResolvedValueOnce({ 
            hash: 'retry-hash', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });

        const promise = service.submitPayment('G-DEST', '10.0');
        
        // Retry after 1 second
        jest.advanceTimersByTime(1000);
        await Promise.resolve();

        const result = await promise;
        expect(result.hash).toBe('retry-hash');
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      it('should handle signing error', async () => {
        const signingError = { code: 'SIGNING_ERROR' };
        mockServer.sendTransaction.mockRejectedValue(signingError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
          code: 'INTERNAL_ERROR',
          message: 'Stellar transaction signing failed',
        });
      });

      it('should handle getAccount failure with retry', async () => {
        jest.useFakeTimers();
        const networkError = new Error('Connection failed');
        networkError.name = 'NetworkError';
        
        mockServer.getAccount
          .mockRejectedValueOnce(networkError)
          .mockRejectedValueOnce(networkError)
          .mockResolvedValueOnce({
            accountId: () => 'G-MOCK-PUBLIC-KEY',
            sequenceNumber: () => '2',
            incrementSequenceNumber: jest.fn(),
          });

        const promise = service.submitPayment('G-DEST', '10.0');
        
        // First retry
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
        
        // Second retry
        jest.advanceTimersByTime(4000);
        await Promise.resolve();

        const result = await promise;
        expect(result.hash).toBe('mock-hash');
        expect(logger.warn).toHaveBeenCalledTimes(2);
      });

      it('should fail after max retries', async () => {
        jest.useFakeTimers();
        const timeoutError = new Error('timeout');
        timeoutError.name = 'AbortError';
        
        mockServer.sendTransaction.mockRejectedValue(timeoutError);

        const promise = service.submitPayment('G-DEST', '10.0');
        
        // Exhaust all retries
        for (let i = 0; i < 3; i++) {
          jest.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 30000));
          await Promise.resolve();
        }

        await expect(promise).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
        });

        expect(logger.warn).toHaveBeenCalledTimes(3);
      });
    });

    describe('invokeContract error scenarios', () => {
      it('should invoke contract successfully', async () => {
        mockServer.sendTransaction.mockResolvedValue({ 
          hash: 'contract-hash', 
          status: 'PENDING',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

        const result = await service.invokeContract('contract-id', 'transfer', ['arg1', 'arg2']);

        expect(result).toBeUndefined(); // resultMeta doesn't exist in SendTransactionResponse
        expect(StellarSdk.Operation.invokeContractFunction).toHaveBeenCalledWith({
          contract: 'contract-id',
          function: 'transfer',
          args: ['arg1', 'arg2'],
        });
      });

      it('should handle contract execution error', async () => {
        const contractError = { code: 'CONTRACT_ERROR' };
        mockServer.sendTransaction.mockRejectedValue(contractError);

        await expect(service.invokeContract('contract-id', 'transfer')).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'Contract execution failed',
        });

        expect(logger.warn).toHaveBeenCalledWith(
          'Stellar RPC operation failed',
          expect.objectContaining({
            failureClass: 'CONTRACT_ERROR',
            operation: 'invoke_contract',
            contractId: 'contract-id',
            functionName: 'transfer',
          })
        );
      });

      it('should handle contract validation error', async () => {
        const validationError = { status: 400 };
        mockServer.sendTransaction.mockRejectedValue(validationError);

        await expect(service.invokeContract('contract-id', 'invalid')).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          message: 'Invalid contract parameters',
        });
      });

      it('should handle contract timeout with retry', async () => {
        jest.useFakeTimers();
        const timeoutError = new Error('Request timeout');
        timeoutError.name = 'AbortError';
        
        mockServer.sendTransaction
          .mockRejectedValueOnce(timeoutError)
          .mockResolvedValueOnce({ 
            hash: 'contract-retry-hash', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });

        const promise = service.invokeContract('contract-id', 'transfer');
        
        // Retry after 1 second
        jest.advanceTimersByTime(1000);
        await Promise.resolve();

        const result = await promise;
        expect(result).toBeUndefined(); // resultMeta doesn't exist in SendTransactionResponse
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      it('should handle transaction status not PENDING', async () => {
        mockServer.sendTransaction.mockResolvedValue({ 
          hash: 'failed-hash', 
          status: 'ERROR', // Use ERROR instead of FAILED
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

        await expect(service.invokeContract('contract-id', 'transfer')).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE', // Falls through to default case
        });
      });

      it('should handle DUPLICATE transaction status', async () => {
        mockServer.sendTransaction.mockResolvedValue({ 
          hash: 'duplicate-hash', 
          status: 'DUPLICATE',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

        await expect(service.invokeContract('contract-id', 'transfer')).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE', // Falls through to default case
        });
      });

      it('should handle TRY_AGAIN_LATER transaction status', async () => {
        mockServer.sendTransaction.mockResolvedValue({ 
          hash: 'retry-later-hash', 
          status: 'TRY_AGAIN_LATER',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

        await expect(service.invokeContract('contract-id', 'transfer')).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
        });
      });
    });

    describe('Error logging and context', () => {
      it('should log failure with correct context', async () => {
        const error = { status: 500 };
        mockServer.sendTransaction.mockRejectedValue(error);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toBeDefined();

        expect(logger.warn).toHaveBeenCalledWith(
          'Stellar RPC operation failed',
          expect.objectContaining({
            failureClass: 'UNKNOWN', // Falls through to UNKNOWN for object errors
            operation: 'submit_payment',
            network: 'testnet',
            attemptCount: 1,
            shouldRetry: true,
          })
        );
      });

      it('should include transaction hash in context when available', async () => {
        const error = { status: 500 };
        mockServer.sendTransaction.mockRejectedValue(error);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toBeDefined();

        expect(logger.warn).toHaveBeenCalledWith(
          'Stellar RPC operation failed',
          expect.objectContaining({
            transactionHash: 'mock-transaction-hash', // From mock transaction
          })
        );
      });

      it('should sanitize error information in logs', async () => {
        const sensitiveError = {
          status: 500,
          message: 'Server error',
          sensitive: 'secret data',
          password: 'hidden',
        };
        mockServer.sendTransaction.mockRejectedValue(sensitiveError);

        await expect(service.submitPayment('G-DEST', '10.0')).rejects.toBeDefined();

        const logCall = (logger.warn as jest.Mock).mock.calls[0];
        const loggedError = logCall[1].originalError as any;
        
        expect(loggedError.status).toBe(500);
        expect(loggedError.message).toBe('Server error');
        expect(loggedError.sensitive).toBeUndefined();
        expect(loggedError.password).toBeUndefined();
      });
    });
  });
});
