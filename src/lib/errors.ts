/**
 * @fileoverview Defines custom application error classes for consistent error handling.
 * This file provides a base `AppError` and specific error types like `NotFoundError`,
 * `UnauthorizedError`, `ForbiddenError`, and `BadRequestError`, aligning with
 * HTTP status codes and structured error responses.
 */

/**
 * Base class for all application-specific errors.
 * Provides a consistent structure for error handling, including HTTP status codes.
 */
export class AppError extends Error {
  public readonly name: string;
  public readonly httpCode: number;
  public readonly isOperational: boolean;

  constructor(name: string, httpCode: number, message: string, isOperational: boolean = true) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype); // Restore prototype chain
    this.name = name;
    this.httpCode = httpCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Not Found') { super('NotFoundError', 404, message); }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') { super('UnauthorizedError', 401, message); }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') { super('ForbiddenError', 403, message); }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad Request') { super('BadRequestError', 400, message); }
}