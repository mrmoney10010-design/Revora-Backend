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
 */
export class StellarSubmissionService {
  private server: StellarSdk.rpc.Server;
  private keypair: StellarSdk.Keypair;

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
   * Submits a simple payment transaction with enhanced error handling.
   * @param to Destination public key
   * @param amount Amount to send (as string)
   * @param asset Asset to send (defaults to native XLM)
   * @returns Transaction result
   */
  async submitPayment(
    to: string,
    amount: string,
    asset: StellarSdk.Asset = StellarSdk.Asset.native(),
  ) {
    const context: StellarRPCFailureContext = {
      operation: 'submit_payment',
      network: env.STELLAR_NETWORK === 'public' ? 'public' : 'testnet',
      attemptCount: 1,
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

      return await this.sendTransactionWithRetry(transaction, context);
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
   * Invokes a Soroban contract with enhanced error handling.
   */
  async invokeContract(
    contractId: string,
    functionName: string,
    args: any[] = [],
  ): Promise<any> {
    const context: StellarRPCFailureContext = {
      operation: 'invoke_contract',
      network: env.STELLAR_NETWORK === 'public' ? 'public' : 'testnet',
      attemptCount: 1,
      contractId,
      functionName,
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

      const result = await this.sendTransactionWithRetry(transaction, context);
      
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
   * Helper method to get account with retry logic.
   */
  private async getAccountWithRetry(
    publicKey: string,
    context: StellarRPCFailureContext
  ): Promise<any> {
    let attemptCount = context.attemptCount || 1;
    
    while (attemptCount <= 3) {
      try {
        return await this.server.getAccount(publicKey);
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'get_account',
          attemptCount,
        });
        
        if (!shouldRetryStellarRPCFailure(failure)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        if (failure.suggestedRetryDelayMs) {
          await this.delay(failure.suggestedRetryDelayMs);
        }
        
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to retrieve Stellar account after multiple attempts');
  }

  /**
   * Helper method to send transaction with retry logic.
   */
  private async sendTransactionWithRetry(
    transaction: StellarSdk.Transaction,
    context: StellarRPCFailureContext
  ): Promise<StellarSdk.rpc.Api.SendTransactionResponse> {
    let attemptCount = context.attemptCount || 1;
    
    while (attemptCount <= 3) {
      try {
        const result = await this.server.sendTransaction(transaction);
        
        // Handle transaction submission results
        if (result.status === 'PENDING') {
          return result;
        } else if (result.status === 'DUPLICATE') {
          throw Errors.conflict('Transaction already submitted', {
            hash: result.hash,
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
          transactionHash: transaction.hash().toString('hex'),
        });
        
        if (!shouldRetryStellarRPCFailure(failure)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        if (failure.suggestedRetryDelayMs) {
          await this.delay(failure.suggestedRetryDelayMs);
        }
        
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to submit Stellar transaction after multiple attempts');
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
   * Utility method for delaying execution.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
