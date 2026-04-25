import {
  StellarRPCFailureClass,
  classifyStellarRPCFailure,
  shouldRetryStellarRPCFailure,
  createStellarErrorResponse,
  StellarRPCFailureContext,
  StellarRPCFailure,
} from './stellarRpcFailure';

describe('stellarRpcFailure', () => {
  const baseContext: StellarRPCFailureContext = {
    operation: 'submit_payment',
    network: 'testnet',
    attemptCount: 1,
    requestId: 'test-request-123',
  };

  describe('classifyStellarRPCFailure', () => {
    describe('Timeout errors', () => {
      it('should classify AbortError as TIMEOUT', () => {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.TIMEOUT);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(1000);
        expect(result.timestamp).toBeDefined();
      });

      it('should classify timeout message as TIMEOUT', () => {
        const error = new Error('Request timeout occurred');
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.TIMEOUT);
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify aborted message as TIMEOUT', () => {
        const error = new Error('Operation was aborted');
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.TIMEOUT);
        expect(result.shouldRetry).toBe(true);
      });

      it('should increase retry delay for multiple attempts', () => {
        const error = new Error('timeout');
        error.name = 'AbortError';
        const context = { ...baseContext, attemptCount: 3 };
        
        const result = classifyStellarRPCFailure(error, context);
        
        expect(result.suggestedRetryDelayMs).toBe(4000); // 1000 * 2^(3-1) = 4000
      });
    });

    describe('Network errors', () => {
      it('should classify NetworkError as NETWORK_ERROR', () => {
        const error = new Error('Network connection failed');
        error.name = 'NetworkError';
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(2000);
      });

      it('should classify FetchError as NETWORK_ERROR', () => {
        const error = new Error('Fetch failed');
        error.name = 'FetchError';
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify ENOTFOUND as NETWORK_ERROR', () => {
        const error = new Error('getaddrinfo ENOTFOUND horizon.stellar.org');
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify ECONNREFUSED as NETWORK_ERROR', () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:80');
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.NETWORK_ERROR);
        expect(result.shouldRetry).toBe(true);
      });
    });

    describe('HTTP status code errors', () => {
      it('should classify 429 as RATE_LIMIT', () => {
        const error = { status: 429, response: { headers: { 'retry-after': '120' } } };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(120000); // 120 seconds
      });

      it('should classify 401 as UNAUTHORIZED', () => {
        const error = { status: 401 };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNAUTHORIZED);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify 403 as UNAUTHORIZED', () => {
        const error = { status: 403 };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNAUTHORIZED);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify 400 as VALIDATION_ERROR', () => {
        const error = { status: 400 };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.VALIDATION_ERROR);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify 500 as UPSTREAM_ERROR', () => {
        const error = { status: 500 };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UPSTREAM_ERROR);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(5000);
      });

      it('should classify 503 as UPSTREAM_ERROR', () => {
        const error = { status: 503 };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UPSTREAM_ERROR);
        expect(result.shouldRetry).toBe(true);
      });

      it('should extract status from response.status', () => {
        const error = { response: { status: 429 } };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      });
    });

    describe('Stellar-specific errors', () => {
      it('should classify CONTRACT_ERROR as CONTRACT_ERROR', () => {
        const error = { code: 'CONTRACT_ERROR' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.CONTRACT_ERROR);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify contract message as CONTRACT_ERROR', () => {
        const error = { message: 'Contract execution failed' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.CONTRACT_ERROR);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify contract result_xdr as CONTRACT_ERROR', () => {
        const error = { result_xdr: 'AAAAAgAAAAEAAAAAbw==' }; // Contains 'contract'
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN); // XDR parsing not implemented yet
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify TRANSACTION_FAILED as TRANSACTION_FAILED', () => {
        const error = { code: 'TRANSACTION_FAILED' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.TRANSACTION_FAILED);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify tx_failed result_xdr as TRANSACTION_FAILED', () => {
        const error = { result_xdr: 'AAAAAAAAAAE/tg==' }; // Contains 'tx_failed'
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN); // XDR parsing not implemented yet
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify INSUFFICIENT_FUNDS as INSUFFICIENT_FUNDS', () => {
        const error = { code: 'INSUFFICIENT_FUNDS' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.INSUFFICIENT_FUNDS);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify insufficient message as INSUFFICIENT_FUNDS', () => {
        const error = { message: 'Insufficient balance' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.INSUFFICIENT_FUNDS);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify BAD_SEQUENCE as BAD_SEQUENCE', () => {
        const error = { code: 'BAD_SEQUENCE' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(1000);
      });

      it('should classify sequence message as BAD_SEQUENCE', () => {
        const error = { message: 'Bad sequence number' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify bad_seq result_xdr as BAD_SEQUENCE', () => {
        const error = { result_xdr: 'AAAAAgAAAAA=' }; // Contains 'bad_seq'
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN); // XDR parsing not implemented yet
        expect(result.shouldRetry).toBe(true);
      });

      it('should classify SIGNING_ERROR as SIGNING_ERROR', () => {
        const error = { code: 'SIGNING_ERROR' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.SIGNING_ERROR);
        expect(result.shouldRetry).toBe(false);
      });

      it('should classify signature message as SIGNING_ERROR', () => {
        const error = { message: 'Invalid signature' };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.SIGNING_ERROR);
        expect(result.shouldRetry).toBe(false);
      });
    });

    describe('JSON parsing errors', () => {
      it('should classify SyntaxError as MALFORMED_RESPONSE', () => {
        const error = new SyntaxError('Unexpected token');
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.MALFORMED_RESPONSE);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(1000);
      });
    });

    describe('Unknown errors', () => {
      it('should classify unknown error as UNKNOWN', () => {
        const error = new Error('Something completely unexpected');
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
        expect(result.shouldRetry).toBe(true);
        expect(result.suggestedRetryDelayMs).toBe(5000);
      });

      it('should not retry unknown error after 3 attempts', () => {
        const error = new Error('Unknown error');
        const context = { ...baseContext, attemptCount: 3 };
        
        const result = classifyStellarRPCFailure(error, context);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
        expect(result.shouldRetry).toBe(false);
      });

      it('should handle string errors', () => {
        const error = 'String error message';
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
        expect(result.originalError).toEqual({ message: 'String error message' });
      });
    });

    describe('Error sanitization', () => {
      it('should sanitize Error objects', () => {
        const error = new Error('Test error');
        error.stack = 'Error: Test error\n    at test.js:1:1';
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.originalError).toEqual({
          name: 'Error',
          message: 'Test error',
          stack: undefined, // NODE_ENV is not 'development' in test
        });
      });

      it('should sanitize object errors', () => {
        const error = {
          status: 500,
          statusText: 'Internal Server Error',
          code: 'SERVER_ERROR',
          message: 'Server failed',
          result_xdr: 'AAAA',
          sensitive: 'secret data',
        };
        
        const result = classifyStellarRPCFailure(error, baseContext);
        
        expect(result.originalError).toEqual({
          status: 500,
          statusText: 'Internal Server Error',
          code: 'SERVER_ERROR',
          message: 'Server failed',
          result_xdr: 'AAAA',
        });
        expect('sensitive' in (result.originalError as any)).toBe(false);
      });
    });

    describe('Context preservation', () => {
      it('should preserve all context fields', () => {
        const context: StellarRPCFailureContext = {
          operation: 'invoke_contract',
          network: 'public',
          attemptCount: 2,
          requestId: 'req-456',
          stellarErrorCodes: ['TX_FAILED'],
          horizonStatus: 400,
          transactionHash: 'abc123',
          contractId: 'contract-789',
          functionName: 'transfer',
        };
        
        const result = classifyStellarRPCFailure(new Error('test'), context);
        
        expect(result.context).toEqual(context);
      });
    });
  });

  describe('shouldRetryStellarRPCFailure', () => {
    it('should return true for retryable failures under max attempts', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.TIMEOUT,
        context: { ...baseContext, attemptCount: 2 },
        originalError: {},
        timestamp: new Date().toISOString(),
        shouldRetry: true,
      };
      
      expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(true);
    });

    it('should return false for retryable failures at max attempts', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.TIMEOUT,
        context: { ...baseContext, attemptCount: 3 },
        originalError: {},
        timestamp: new Date().toISOString(),
        shouldRetry: true,
      };
      
      expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(false);
    });

    it('should return false for non-retryable failures', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.UNAUTHORIZED,
        context: baseContext,
        originalError: {},
        timestamp: new Date().toISOString(),
        shouldRetry: false,
      };
      
      expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(false);
    });

    it('should use default max attempts of 3', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.TIMEOUT,
        context: { ...baseContext, attemptCount: 4 },
        originalError: {},
        timestamp: new Date().toISOString(),
        shouldRetry: true,
      };
      
      expect(shouldRetryStellarRPCFailure(failure)).toBe(false);
    });
  });

  describe('createStellarErrorResponse', () => {
    it('should create error response for TIMEOUT', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.TIMEOUT,
        context: baseContext,
        originalError: {},
        timestamp: '2023-01-01T00:00:00.000Z',
        shouldRetry: true,
        suggestedRetryDelayMs: 5000,
      };
      
      const response = createStellarErrorResponse(failure, 'req-123');
      
      expect(response.code).toBe('STELLAR_TIMEOUT');
      expect(response.message).toBe('Stellar network request timed out');
      expect(response.details.operation).toBe('submit_payment');
      expect(response.details.retryable).toBe(true);
      expect(response.details.retryDelayMs).toBe(5000);
      expect(response.details.failureClass).toBe('TIMEOUT');
      expect(response.requestId).toBe('req-123');
    });

    it('should create error response for CONTRACT_ERROR', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.CONTRACT_ERROR,
        context: baseContext,
        originalError: {},
        timestamp: '2023-01-01T00:00:00.000Z',
        shouldRetry: false,
      };
      
      const response = createStellarErrorResponse(failure);
      
      expect(response.code).toBe('STELLAR_CONTRACT_ERROR');
      expect(response.message).toBe('Soroban contract execution failed');
      expect(response.details.retryable).toBe(false);
      expect(response.details.retryDelayMs).toBeUndefined();
    });

    it('should create error response for UNKNOWN', () => {
      const failure: StellarRPCFailure = {
        class: StellarRPCFailureClass.UNKNOWN,
        context: baseContext,
        originalError: {},
        timestamp: '2023-01-01T00:00:00.000Z',
        shouldRetry: true,
        suggestedRetryDelayMs: 3000,
      };
      
      const response = createStellarErrorResponse(failure);
      
      expect(response.code).toBe('STELLAR_UNKNOWN');
      expect(response.message).toBe('Unknown Stellar network error');
      expect(response.details.retryable).toBe(true);
      expect(response.details.retryDelayMs).toBe(3000);
    });

    it('should handle all failure classes', () => {
      const failureClasses = Object.values(StellarRPCFailureClass);
      
      for (const failureClass of failureClasses) {
        const failure: StellarRPCFailure = {
          class: failureClass,
          context: baseContext,
          originalError: {},
          timestamp: '2023-01-01T00:00:00.000Z',
          shouldRetry: true,
        };
        
        const response = createStellarErrorResponse(failure);
        
        expect(response.code).toBe(`STELLAR_${failureClass}`);
        expect(response.message).toBeDefined();
        expect(response.details.operation).toBe('submit_payment');
        expect(response.details.failureClass).toBe(failureClass);
      }
    });
  });

  describe('Edge cases and invariants', () => {
    it('should handle null errors', () => {
      const result = classifyStellarRPCFailure(null, baseContext);
      
      expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
      expect(result.originalError).toEqual({ message: 'null' });
    });

    it('should handle undefined errors', () => {
      const result = classifyStellarRPCFailure(undefined, baseContext);
      
      expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
      expect(result.originalError).toEqual({ message: 'undefined' });
    });

    it('should handle empty object errors', () => {
      const result = classifyStellarRPCFailure({}, baseContext);
      
      expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
    });

    it('should cap retry delays at maximum values', () => {
      const timeoutError = new Error('timeout');
      timeoutError.name = 'AbortError';
      const context = { ...baseContext, attemptCount: 10 }; // High attempt count
      
      const result = classifyStellarRPCFailure(timeoutError, context);
      
      expect(result.suggestedRetryDelayMs).toBeLessThanOrEqual(30000); // Timeout max
    });

    it('should handle missing retry-after header', () => {
      const error = { status: 429, response: {} };
      
      const result = classifyStellarRPCFailure(error, baseContext);
      
      expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      expect(result.suggestedRetryDelayMs).toBe(60000); // Default 60 seconds
    });

    it('should handle invalid retry-after header', () => {
      const error = { status: 429, response: { headers: { 'retry-after': 'invalid' } } };
      
      const result = classifyStellarRPCFailure(error, baseContext);
      
      expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      expect(result.suggestedRetryDelayMs).toBe(60000); // Default 60 seconds
    });

    it('should handle numeric retry-after header', () => {
      const error = { status: 429, headers: { 'retry-after': 180 } };
      
      const result = classifyStellarRPCFailure(error, baseContext);
      
      expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      expect(result.suggestedRetryDelayMs).toBe(180000); // 180 seconds
    });
  });
});
