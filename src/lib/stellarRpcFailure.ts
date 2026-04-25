/**
 * @dev Stable classification for failures returned by Stellar-facing dependencies.
 * Raw upstream messages must never cross the API trust boundary.
 */
export enum StellarRPCFailureClass {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  CONTRACT_ERROR = 'CONTRACT_ERROR',
  BAD_SEQUENCE = 'BAD_SEQUENCE',
  SIGNING_ERROR = 'SIGNING_ERROR',
  UNKNOWN = 'UNKNOWN',
}

/**
 * @dev Detailed failure context for structured logging and debugging.
 */
export interface StellarRPCFailureContext {
  operation: 'submit_payment' | 'invoke_contract' | 'get_account' | 'send_transaction' | 'simulate_transaction';
  network: 'public' | 'testnet' | 'custom';
  attemptCount?: number;
  requestId?: string;
  stellarErrorCodes?: string[];
  horizonStatus?: number;
  transactionHash?: string;
  contractId?: string;
  functionName?: string;
}

/**
 * @dev Enhanced failure information with classification and context.
 */
export interface StellarRPCFailure {
  class: StellarRPCFailureClass;
  context: StellarRPCFailureContext;
  originalError: unknown;
  timestamp: string;
  shouldRetry: boolean;
  suggestedRetryDelayMs?: number;
}

/**
 * @dev Maps arbitrary dependency failures into deterministic, client-safe buckets.
 * Enhanced to handle Soroban-specific errors and provide retry guidance.
 */
export function classifyStellarRPCFailure(
  error: unknown,
  context: StellarRPCFailureContext
): StellarRPCFailure {
  const timestamp = new Date().toISOString();
  
  // Timeout errors
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || 
     error.message.toLowerCase().includes('timeout') ||
     error.message.toLowerCase().includes('aborted'))
  ) {
    return {
      class: StellarRPCFailureClass.TIMEOUT,
      context,
      originalError: sanitizeError(error),
      timestamp,
      shouldRetry: true,
      suggestedRetryDelayMs: Math.min(1000 * Math.pow(2, (context.attemptCount || 1) - 1), 30000),
    };
  }

  // Network connectivity errors
  if (
    error instanceof Error &&
    (error.name === 'NetworkError' ||
     error.name === 'FetchError' ||
     error.message.toLowerCase().includes('network') ||
     error.message.toLowerCase().includes('connection') ||
     error.message.toLowerCase().includes('enotfound') ||
     error.message.toLowerCase().includes('econnrefused'))
  ) {
    return {
      class: StellarRPCFailureClass.NETWORK_ERROR,
      context,
      originalError: sanitizeError(error),
      timestamp,
      shouldRetry: true,
      suggestedRetryDelayMs: Math.min(2000 * Math.pow(2, (context.attemptCount || 1) - 1), 60000),
    };
  }

  // HTTP status code based classification
  if (typeof error === 'object' && error !== null) {
    const errObj = error as any;
    const status = errObj.status || errObj.response?.status;
    
    if (status === 429) {
      return {
        class: StellarRPCFailureClass.RATE_LIMIT,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: true,
        suggestedRetryDelayMs: extractRetryAfter(errObj) || 60000,
      };
    }
    
    if (status === 401 || status === 403) {
      return {
        class: StellarRPCFailureClass.UNAUTHORIZED,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
    
    if (status === 400) {
      return {
        class: StellarRPCFailureClass.VALIDATION_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
    
    if (typeof status === 'number' && status >= 500) {
      return {
        class: StellarRPCFailureClass.UPSTREAM_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: true,
        suggestedRetryDelayMs: Math.min(5000 * Math.pow(2, (context.attemptCount || 1) - 1), 120000),
      };
    }
  }

  // Stellar-specific transaction errors
  if (typeof error === 'object' && error !== null) {
    const errObj = error as any;
    
    // Soroban contract errors
    if (errObj.code === 'CONTRACT_ERROR' || 
        errObj.message?.toLowerCase().includes('contract') ||
        errObj.result_xdr?.includes('contract')) {
      return {
        class: StellarRPCFailureClass.CONTRACT_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
    
    // Transaction failure codes
    if (errObj.code === 'TRANSACTION_FAILED' ||
        errObj.result_xdr?.includes('tx_failed') ||
        errObj.message?.toLowerCase().includes('transaction failed')) {
      return {
        class: StellarRPCFailureClass.TRANSACTION_FAILED,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
    
    // Insufficient funds
    if (errObj.code === 'INSUFFICIENT_FUNDS' ||
        errObj.message?.toLowerCase().includes('insufficient') ||
        errObj.result_xdr?.includes('insufficient')) {
      return {
        class: StellarRPCFailureClass.INSUFFICIENT_FUNDS,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
    
    // Bad sequence number
    if (errObj.code === 'BAD_SEQUENCE' ||
        errObj.message?.toLowerCase().includes('sequence') ||
        errObj.result_xdr?.includes('bad_seq')) {
      return {
        class: StellarRPCFailureClass.BAD_SEQUENCE,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: true,
        suggestedRetryDelayMs: 1000,
      };
    }
    
    // Signing errors
    if (errObj.code === 'SIGNING_ERROR' ||
        errObj.message?.toLowerCase().includes('signature') ||
        errObj.message?.toLowerCase().includes('signing')) {
      return {
        class: StellarRPCFailureClass.SIGNING_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
  }

  // JSON parsing errors
  if (error instanceof SyntaxError) {
    return {
      class: StellarRPCFailureClass.MALFORMED_RESPONSE,
      context,
      originalError: sanitizeError(error),
      timestamp,
      shouldRetry: true,
      suggestedRetryDelayMs: 1000,
    };
  }

  // Default unknown error
  return {
    class: StellarRPCFailureClass.UNKNOWN,
    context,
    originalError: sanitizeError(error),
    timestamp,
    shouldRetry: context.attemptCount === undefined || context.attemptCount < 3,
    suggestedRetryDelayMs: 5000,
  };
}

/**
 * @dev Sanitizes error objects to prevent sensitive data leakage.
 */
function sanitizeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    };
  }
  
  if (typeof error === 'object' && error !== null) {
    const sanitized: any = {};
    const allowedKeys = ['status', 'statusText', 'code', 'message', 'result_xdr'];
    
    for (const key of allowedKeys) {
      if (key in error) {
        sanitized[key] = (error as any)[key];
      }
    }
    
    return sanitized;
  }
  
  return { message: String(error) };
}

/**
 * @dev Extracts retry-after header value from error response.
 */
function extractRetryAfter(error: any): number | undefined {
  const retryAfter = error?.response?.headers?.['retry-after'] || 
                    error?.headers?.['retry-after'];
  
  if (typeof retryAfter === 'string') {
    const parsed = parseInt(retryAfter, 10);
    return isNaN(parsed) ? undefined : parsed * 1000; // Convert to milliseconds
  }
  
  if (typeof retryAfter === 'number') {
    return retryAfter * 1000;
  }
  
  return undefined;
}

/**
 * @dev Determines if a Stellar RPC failure should be retried based on classification and attempt count.
 */
export function shouldRetryStellarRPCFailure(
  failure: StellarRPCFailure,
  maxAttempts: number = 3
): boolean {
  return failure.shouldRetry && (failure.context.attemptCount || 1) < maxAttempts;
}

/**
 * @dev Creates a standardized error response for Stellar RPC failures.
 */
export function createStellarErrorResponse(
  failure: StellarRPCFailure,
  requestId?: string
): {
  code: string;
  message: string;
  details: {
    operation: string;
    retryable: boolean;
    retryDelayMs?: number;
    failureClass: string;
  };
  requestId?: string;
} {
  const messages = {
    [StellarRPCFailureClass.TIMEOUT]: 'Stellar network request timed out',
    [StellarRPCFailureClass.RATE_LIMIT]: 'Stellar network rate limit exceeded',
    [StellarRPCFailureClass.UPSTREAM_ERROR]: 'Stellar network temporarily unavailable',
    [StellarRPCFailureClass.MALFORMED_RESPONSE]: 'Invalid response from Stellar network',
    [StellarRPCFailureClass.UNAUTHORIZED]: 'Authentication with Stellar network failed',
    [StellarRPCFailureClass.NETWORK_ERROR]: 'Network connection to Stellar failed',
    [StellarRPCFailureClass.VALIDATION_ERROR]: 'Invalid Stellar transaction data',
    [StellarRPCFailureClass.INSUFFICIENT_FUNDS]: 'Insufficient funds for Stellar transaction',
    [StellarRPCFailureClass.TRANSACTION_FAILED]: 'Stellar transaction failed',
    [StellarRPCFailureClass.CONTRACT_ERROR]: 'Soroban contract execution failed',
    [StellarRPCFailureClass.BAD_SEQUENCE]: 'Stellar sequence number invalid',
    [StellarRPCFailureClass.SIGNING_ERROR]: 'Stellar transaction signing failed',
    [StellarRPCFailureClass.UNKNOWN]: 'Unknown Stellar network error',
  };

  return {
    code: `STELLAR_${failure.class}`,
    message: messages[failure.class] || messages[StellarRPCFailureClass.UNKNOWN],
    details: {
      operation: failure.context.operation,
      retryable: failure.shouldRetry,
      retryDelayMs: failure.suggestedRetryDelayMs,
      failureClass: failure.class,
    },
    requestId,
  };
}
