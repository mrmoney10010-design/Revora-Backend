import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarSubmissionService } from './stellarSubmissionService';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';

// Mock logger
jest.mock('../lib/logger', () => ({
  globalLogger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock transaction with hash method
const mockTransaction = {
  hash: jest.fn().mockReturnValue('mock-transaction-hash'),
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

  describe('Enhanced Idempotency Features', () => {
    it('should prevent duplicate transaction submissions', async () => {
      const to = 'G-DESTINATION';
      const amount = '10.0';
      const idempotencyKey = 'test-key-123';

      // First submission should succeed
      const result1 = await service.submitPayment(to, amount, undefined, idempotencyKey);
      expect(result1).toEqual({ hash: 'mock-hash', status: 'PENDING' });

      // Second submission with same transaction hash should fail
      await expect(service.submitPayment(to, amount, undefined, idempotencyKey)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Transaction already submitted',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Duplicate transaction submission prevented',
        expect.objectContaining({
          transactionHash: 'mock-transaction-hash',
          idempotencyKey,
          operation: 'submit_payment',
        })
      );
    });

    it('should prevent duplicate contract invocations', async () => {
      const contractId = 'contract-id';
      const functionName = 'transfer';
      const idempotencyKey = 'contract-key-456';

      // First invocation should succeed
      const result1 = await service.invokeContract(contractId, functionName, [], idempotencyKey);
      expect(result1).toEqual({ hash: 'mock-hash', status: 'PENDING' });

      // Second invocation with same transaction hash should fail
      await expect(service.invokeContract(contractId, functionName, [], idempotencyKey)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Contract invocation already submitted',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Duplicate contract invocation prevented',
        expect.objectContaining({
          transactionHash: 'mock-transaction-hash',
          contractId,
          functionName,
          idempotencyKey,
          operation: 'invoke_contract',
        })
      );
    });

    it('should allow different transactions with same idempotency key', async () => {
      const to = 'G-DESTINATION';
      const amount = '10.0';
      const idempotencyKey = 'test-key-789';

      // First submission
      await service.submitPayment(to, amount, undefined, idempotencyKey);

      // Clear the cache to simulate different transaction
      service.clearTransactionCache();

      // Second submission should succeed (different transaction hash would be generated)
      const result2 = await service.submitPayment(to + '2', amount, undefined, idempotencyKey);
      expect(result2).toEqual({ hash: 'mock-hash', status: 'PENDING' });
    });

    it('should track transaction cache size', () => {
      expect(service.getTransactionCacheSize()).toBe(0);
      
      service.clearTransactionCache();
      expect(service.getTransactionCacheSize()).toBe(0);
    });

    it('should clear transaction cache', async () => {
      const to = 'G-DESTINATION';
      const amount = '10.0';

      // Submit a transaction to add to cache
      await service.submitPayment(to, amount);
      expect(service.getTransactionCacheSize()).toBe(1);

      // Clear cache
      service.clearTransactionCache();
      expect(service.getTransactionCacheSize()).toBe(0);
      expect(logger.debug).toHaveBeenCalledWith('Stellar transaction cache cleared');
    });
  });

  describe('Enhanced Retry Logic with Exponential Backoff', () => {
    it('should use exponential backoff for retries', async () => {
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
      
      // First retry - should use exponential backoff with jitter
      jest.advanceTimersByTime(1000); // Base delay with jitter
      await Promise.resolve();
      
      // Second retry - should use longer delay
      jest.advanceTimersByTime(2000); // 2x base delay with jitter
      await Promise.resolve();

      const result = await promise;
      expect(result.hash).toBe('retry-hash');
      expect(logger.debug).toHaveBeenCalledWith(
        'Retrying Stellar transaction submission',
        expect.objectContaining({
          attemptCount: expect.any(Number),
          delayMs: expect.any(Number),
          failureClass: 'TIMEOUT',
        })
      );
    });

    it('should log successful retries', async () => {
      jest.useFakeTimers();
      const networkError = new Error('Connection failed');
      networkError.name = 'NetworkError';
      
      mockServer.sendTransaction
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ 
          hash: 'success-after-retry', 
          status: 'PENDING',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

      const promise = service.submitPayment('G-DEST', '10.0');
      
      // Advance timers for retry
      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      const result = await promise;
      expect(result.hash).toBe('success-after-retry');
      
      expect(logger.info).toHaveBeenCalledWith(
        'Stellar transaction submission succeeded after retry',
        expect.objectContaining({
          transactionHash: 'mock-transaction-hash',
          attemptCount: 2,
          operation: 'send_transaction',
        })
      );
    });

    it('should fail after maximum retries with detailed error', async () => {
      jest.useFakeTimers();
      const timeoutError = new Error('timeout');
      timeoutError.name = 'AbortError';
      
      mockServer.sendTransaction.mockRejectedValue(timeoutError);

      const promise = service.submitPayment('G-DEST', '10.0');
      
      // Exhaust all retries (3 attempts)
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 30000));
        await Promise.resolve();
      }

      await expect(promise).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Failed to submit Stellar transaction after maximum retries',
      });

      expect(logger.warn).toHaveBeenCalledTimes(3);
    });
  });

  describe('Enhanced Error Classification', () => {
    it('should handle enhanced contract error detection', async () => {
      const contractError = { 
        error: 'Contract execution failed',
        details: 'contract error details'
      };
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
        })
      );
    });

    it('should handle enhanced insufficient funds detection', async () => {
      const insufficientError = { 
        message: 'Account underfunded - no trustline',
      };
      mockServer.sendTransaction.mockRejectedValue(insufficientError);

      await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Insufficient funds for payment',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Stellar RPC operation failed',
        expect.objectContaining({
          failureClass: 'INSUFFICIENT_FUNDS',
        })
      );
    });

    it('should handle enhanced signing error detection', async () => {
      const signingError = { 
        message: 'Signature verification failed',
      };
      mockServer.sendTransaction.mockRejectedValue(signingError);

      await expect(service.submitPayment('G-DEST', '10.0')).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Stellar transaction signing failed',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Stellar RPC operation failed',
        expect.objectContaining({
          failureClass: 'SIGNING_ERROR',
        })
      );
    });

    it('should handle enhanced sequence error detection', async () => {
      jest.useFakeTimers();
      const sequenceError = { 
        message: 'Bad sequence number',
      };
      
      mockServer.sendTransaction
        .mockRejectedValueOnce(sequenceError)
        .mockResolvedValueOnce({ 
          hash: 'sequence-fixed', 
          status: 'PENDING',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

      const promise = service.submitPayment('G-DEST', '10.0');
      
      // Retry after 1 second for sequence error
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      const result = await promise;
      expect(result.hash).toBe('sequence-fixed');
      
      expect(logger.warn).toHaveBeenCalledWith(
        'Stellar RPC operation failed',
        expect.objectContaining({
          failureClass: 'BAD_SEQUENCE',
        })
      );
    });
  });

  describe('Account Retrieval with Enhanced Retry', () => {
    it('should retry account retrieval with exponential backoff', async () => {
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
      
      expect(logger.info).toHaveBeenCalledWith(
        'Stellar account retrieval succeeded after retry',
        expect.objectContaining({
          publicKey: 'G-MOCK-PUBLIC-KEY',
          attemptCount: 3,
          operation: 'get_account',
        })
      );
    });

    it('should fail account retrieval after max retries', async () => {
      jest.setTimeout(10000);
      jest.useFakeTimers();
      const networkError = new Error('Persistent connection failure');
      networkError.name = 'NetworkError';
      
      mockServer.getAccount.mockRejectedValue(networkError);

      const promise = service.submitPayment('G-DEST', '10.0');
      
      // Exhaust all retries for account retrieval
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(Math.min(2000 * Math.pow(2, i), 30000));
        await Promise.resolve();
      }

      await expect(promise).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Failed to retrieve Stellar account after maximum retries',
      });
    });

  describe('Error logging and context', () => {
    it('should log failure with correct context including idempotency key', async () => {
        const error = { status: 500 };
        mockServer.sendTransaction.mockRejectedValue(error);
        const idempotencyKey = 'test-key-123';

        await expect(service.submitPayment('G-DEST', '10.0', undefined, idempotencyKey)).rejects.toBeDefined();

        expect(logger.warn).toHaveBeenCalledWith(
          'Stellar RPC operation failed',
          expect.objectContaining({
            failureClass: 'UNKNOWN',
            operation: 'submit_payment',
            network: 'testnet',
            attemptCount: 1,
            shouldRetry: true,
            idempotencyKey,
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
            transactionHash: 'mock-transaction-hash',
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

      it('should log debug information for retry attempts', async () => {
        jest.useFakeTimers();
        const timeoutError = new Error('timeout');
        timeoutError.name = 'AbortError';
        
        mockServer.sendTransaction
          .mockRejectedValueOnce(timeoutError)
          .mockResolvedValueOnce({ 
            hash: 'retry-success', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });

        const promise = service.submitPayment('G-DEST', '10.0');
        
        // Trigger retry
        jest.advanceTimersByTime(1000);
        await Promise.resolve();

        await promise;

        expect(logger.debug).toHaveBeenCalledWith(
          'Retrying Stellar transaction submission',
          expect.objectContaining({
            transactionHash: 'mock-transaction-hash',
            attemptCount: 2,
            delayMs: expect.any(Number),
            nextAttempt: 3,
            failureClass: 'TIMEOUT',
          })
        );
      });
    });
  });
});
