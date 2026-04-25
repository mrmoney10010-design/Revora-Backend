import * as StellarSdk from '@stellar/stellar-sdk';
import { env } from '../config/env';
import { 
  classifyStellarRPCFailure, 
  shouldRetryStellarRPCFailure,
  createStellarErrorResponse,
  StellarRPCFailureContext,
  StellarRPCFailure,
  StellarRPCFailureClass 
} from '../lib/stellarRpcFailure';
import { AppError, Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';

/**
 * Service for building and submitting Stellar transactions.
 * 
 * Features:
 * - Retry logic with exponential backoff and idempotency
 * - Comprehensive RPC failure classification
 * - Structured logging and error handling
 * - Transaction deduplication prevention
 */
export class StellarSubmissionService {
  private server: StellarSdk.rpc.Server;
  private keypair: StellarSdk.Keypair;
  private submittedTransactionHashes = new Set<string>();
  private readonly maxRetries = 3;
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 30000;

  constructor() {
    const horizonUrl =
      env.STELLAR_HORIZON_URL ||
      (env.STELLAR_NETWORK === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org');

    this.server = new StellarSdk.rpc.Server(horizonUrl);

    const secret = process.env.STELLAR_SERVER_SECRET;
    if (!secret) {
      throw new Error('STELLAR_SERVER_SECRET is not defined in environment variables');
    }

    try {
      this.keypair = StellarSdk.Keypair.fromSecret(secret);
    } catch {
      throw new Error('Invalid STELLAR_SERVER_SECRET provided');
    }
  }

  /**
   * Submits a simple payment transaction with enhanced error handling and idempotency.
   * @param to Destination public key
   * @param amount Amount to send (as string)
   * @param asset Asset to send (defaults to native XLM)
   * @param idempotencyKey Optional key to prevent duplicate submissions
   * @returns Transaction result
   */
  async submitPayment(
    to: string,
    amount: string,
    asset: StellarSdk.Asset = StellarSdk.Asset.native(),
    idempotencyKey?: string,
  ) {
    const context: StellarRPCFailureContext = {
      operation: 'submit_payment',
      network: env.STELLAR_NETWORK === 'public' ? 'public' : 'testnet',
      attemptCount: 1,
      idempotencyKey,
    };

    try {
      const sourceAccount = await this.getAccountWithRetry(this.keypair.publicKey(), context);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase:
          env.STELLAR_NETWORK_PASSPHRASE ||
          (env.STELLAR_NETWORK === 'public'
            ? StellarSdk.Networks.PUBLIC
            : StellarSdk.Networks.TESTNET),
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: to,
            asset,
            amount,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.keypair);
      
      // Check for idempotency to prevent duplicate submissions
      const transactionHash = transaction.hash().toString('hex');
      if (this.submittedTransactionHashes.has(transactionHash)) {
        logger.warn('Duplicate transaction submission prevented', {
          transactionHash,
          idempotencyKey,
          operation: 'submit_payment',
        });
        throw Errors.conflict('Transaction already submitted', {
          hash: transactionHash,
          idempotencyKey,
        });
      }

      const result = await this.sendTransactionWithRetry(transaction, context);
      
      // Mark transaction as submitted to prevent duplicates
      this.submittedTransactionHashes.add(transactionHash);
      
      return result;
    } catch (error) {
      const failure = classifyStellarRPCFailure(error, context);
      this.logStellarFailure(failure);
      
      if (failure.class === StellarRPCFailureClass.INSUFFICIENT_FUNDS) {
        throw Errors.badRequest('Insufficient funds for payment', {
          operation: context.operation,
          amount,
          asset: asset.getCode(),
        });
      }
      
      if (failure.class === StellarRPCFailureClass.VALIDATION_ERROR) {
        throw Errors.validationError('Invalid payment parameters', {
          destination: to,
          amount,
          asset: asset.getCode(),
        });
      }
      
      throw this.createAppErrorFromFailure(failure);
    }
  }

  /**
   * Invokes a Soroban contract with enhanced error handling and idempotency.
   * @param contractId Contract ID to invoke
   * @param functionName Function name to call
   * @param args Function arguments
   * @param idempotencyKey Optional key to prevent duplicate submissions
   * @returns Transaction result
   */
  async invokeContract(
    contractId: string,
    functionName: string,
    args: any[] = [],
    idempotencyKey?: string,
  ): Promise<any> {
    const context: StellarRPCFailureContext = {
      operation: 'invoke_contract',
      network: env.STELLAR_NETWORK === 'public' ? 'public' : 'testnet',
      attemptCount: 1,
      contractId,
      functionName,
      idempotencyKey,
    };

    try {
      // Get account for transaction
      const sourceAccount = await this.getAccountWithRetry(this.keypair.publicKey(), context);

      // Build Soroban transaction
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase:
          env.STELLAR_NETWORK_PASSPHRASE ||
          (env.STELLAR_NETWORK === 'public'
            ? StellarSdk.Networks.PUBLIC
            : StellarSdk.Networks.TESTNET),
      })
        .addOperation(
          StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: functionName,
            args: args,
          })
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.keypair);
      
      // Check for idempotency to prevent duplicate submissions
      const transactionHash = transaction.hash().toString('hex');
      if (this.submittedTransactionHashes.has(transactionHash)) {
        logger.warn('Duplicate contract invocation prevented', {
          transactionHash,
          contractId,
          functionName,
          idempotencyKey,
          operation: 'invoke_contract',
        });
        throw Errors.conflict('Contract invocation already submitted', {
          hash: transactionHash,
          contractId,
          functionName,
          idempotencyKey,
        });
      }

      const result = await this.sendTransactionWithRetry(transaction, context);
      
      // Mark transaction as submitted to prevent duplicates
      this.submittedTransactionHashes.add(transactionHash);

      // Parse and return contract result
      if (result.status === 'PENDING') {
        return result; // Return the full transaction response
      } else {
        throw new Error(`Contract invocation failed: ${result.status}`);
      }
    } catch (error) {
      const failure = classifyStellarRPCFailure(error, context);
      this.logStellarFailure(failure);
      
      if (failure.class === StellarRPCFailureClass.CONTRACT_ERROR) {
        throw Errors.badRequest('Contract execution failed', {
          contractId,
          functionName,
          args,
        });
      }
      
      if (failure.class === StellarRPCFailureClass.VALIDATION_ERROR) {
        throw Errors.validationError('Invalid contract parameters', {
          contractId,
          functionName,
          args,
        });
      }
      
      throw this.createAppErrorFromFailure(failure);
    }
  }

  /**
   * Gets the public key of the service's keypair.
   */
  getPublicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Helper method to get account with enhanced retry logic and exponential backoff.
   */
  private async getAccountWithRetry(
    publicKey: string,
    context: StellarRPCFailureContext
  ): Promise<any> {
    let attemptCount = context.attemptCount || 1;
    
    while (attemptCount <= this.maxRetries) {
      try {
        const account = await this.server.getAccount(publicKey);
        
        // Log successful retry if applicable
        if (attemptCount > 1) {
          logger.info('Stellar account retrieval succeeded after retry', {
            publicKey,
            attemptCount,
            operation: 'get_account',
          });
        }
        
        return account;
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'get_account',
          attemptCount,
        });
        
        if (!shouldRetryStellarRPCFailure(failure, this.maxRetries)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        // Calculate exponential backoff delay
        const delayMs = this.calculateRetryDelay(failure.suggestedRetryDelayMs, attemptCount);
        logger.debug('Retrying Stellar account retrieval', {
          publicKey,
          attemptCount,
          delayMs,
          nextAttempt: attemptCount + 1,
        });
        
        await this.delay(delayMs);
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to retrieve Stellar account after maximum retries', {
      publicKey,
      maxRetries: this.maxRetries,
      operation: 'get_account',
    });
  }

  /**
   * Helper method to send transaction with enhanced retry logic and exponential backoff.
   */
  private async sendTransactionWithRetry(
    transaction: StellarSdk.Transaction,
    context: StellarRPCFailureContext
  ): Promise<StellarSdk.rpc.Api.SendTransactionResponse> {
    let attemptCount = context.attemptCount || 1;
    const transactionHash = transaction.hash().toString('hex');
    
    while (attemptCount <= this.maxRetries) {
      try {
        const result = await this.server.sendTransaction(transaction);
        
        // Log successful retry if applicable
        if (attemptCount > 1) {
          logger.info('Stellar transaction submission succeeded after retry', {
            transactionHash,
            attemptCount,
            operation: 'send_transaction',
          });
        }
        
        // Handle transaction submission results
        if (result.status === 'PENDING') {
          return result;
        } else if (result.status === 'DUPLICATE') {
          throw Errors.conflict('Transaction already submitted', {
            hash: result.hash,
            transactionHash,
          });
        } else if (result.status === 'TRY_AGAIN_LATER') {
          throw new Error('Transaction rate limited, try again later');
        } else {
          throw new Error(`Transaction failed: ${result.status}`);
        }
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'send_transaction',
          attemptCount,
          transactionHash,
        });
        
        if (!shouldRetryStellarRPCFailure(failure, this.maxRetries)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        // Calculate exponential backoff delay
        const delayMs = this.calculateRetryDelay(failure.suggestedRetryDelayMs, attemptCount);
        logger.debug('Retrying Stellar transaction submission', {
          transactionHash,
          attemptCount,
          delayMs,
          nextAttempt: attemptCount + 1,
          failureClass: failure.class,
        });
        
        await this.delay(delayMs);
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to submit Stellar transaction after maximum retries', {
      transactionHash,
      maxRetries: this.maxRetries,
      operation: 'send_transaction',
    });
  }

  /**
   * Creates an AppError from a Stellar RPC failure.
   */
  private createAppErrorFromFailure(failure: StellarRPCFailure): AppError {
    const errorResponse = createStellarErrorResponse(failure);
    
    switch (failure.class) {
      case StellarRPCFailureClass.TIMEOUT:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.RATE_LIMIT:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.UPSTREAM_ERROR:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.NETWORK_ERROR:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.UNAUTHORIZED:
        return Errors.unauthorized(errorResponse.message);
      
      case StellarRPCFailureClass.TRANSACTION_FAILED:
        return Errors.badRequest(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.BAD_SEQUENCE:
        return Errors.badRequest(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.SIGNING_ERROR:
        return Errors.internal(errorResponse.message, errorResponse.details);
      
      default:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
    }
  }

  /**
   * Logs Stellar RPC failures for monitoring and debugging.
   */
  private logStellarFailure(failure: StellarRPCFailure): void {
    logger.warn('Stellar RPC operation failed', {
      failureClass: failure.class,
      operation: failure.context.operation,
      network: failure.context.network,
      attemptCount: failure.context.attemptCount,
      shouldRetry: failure.shouldRetry,
      suggestedDelay: failure.suggestedRetryDelayMs,
      originalError: failure.originalError,
      contractId: failure.context.contractId,
      functionName: failure.context.functionName,
      transactionHash: failure.context.transactionHash,
    });
  }

  /**
   * Calculates retry delay with exponential backoff and jitter.
   * @param suggestedDelayMs Suggested delay from failure classification
   * @param attemptCount Current attempt number
   * @returns Calculated delay in milliseconds
   */
  private calculateRetryDelay(suggestedDelayMs?: number, attemptCount: number = 1): number {
    // Use suggested delay if provided, otherwise calculate exponential backoff
    const baseDelay = suggestedDelayMs ?? this.baseDelayMs;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, attemptCount - 1), this.maxDelayMs);
    
    // Add jitter to prevent thundering herd (±25% random variation)
    const jitter = Math.random() * 0.5 - 0.25; // ±25%
    const finalDelay = Math.round(exponentialDelay * (1 + jitter));
    
    return Math.max(this.baseDelayMs, finalDelay); // Ensure minimum delay
  }

  /**
   * Utility method for delaying execution with Promise.
   * @param ms Delay in milliseconds
   * @returns Promise that resolves after delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clears the transaction hash cache (useful for testing or memory management).
   */
  clearTransactionCache(): void {
    this.submittedTransactionHashes.clear();
    logger.debug('Stellar transaction cache cleared');
  }

  /**
   * Gets the current size of the transaction hash cache.
   * @returns Number of cached transaction hashes
   */
  getTransactionCacheSize(): number {
    return this.submittedTransactionHashes.size;
  }
}
