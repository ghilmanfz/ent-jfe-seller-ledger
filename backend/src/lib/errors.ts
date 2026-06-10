export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'CARD_DECLINED'
  | 'STRIPE_ERROR'
  | 'LEDGER_IMBALANCED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', 400, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', 404, message);
  }
}

/**
 * Another writer appended to the same aggregate first. The caller's view of the
 * world is stale: re-read and decide whether the operation still makes sense.
 */
export class VersionConflictError extends AppError {
  constructor(aggregateId: string, version?: number) {
    super(
      'VERSION_CONFLICT',
      409,
      `Concurrent write on aggregate "${aggregateId}"${version !== undefined ? ` (version ${version} already exists)` : ''}. Re-read the order and retry if still applicable.`,
      { aggregateId, version },
    );
  }
}

/** Same idempotencyKey reused with different parameters — always a client bug. */
export class IdempotencyConflictError extends AppError {
  constructor(key: string, details?: unknown) {
    super(
      'IDEMPOTENCY_CONFLICT',
      422,
      `idempotencyKey "${key}" was already used with different parameters`,
      details,
    );
  }
}

export class InvalidTransitionError extends AppError {
  constructor(message: string, details?: unknown) {
    super('INVALID_TRANSITION', 409, message, details);
  }
}

export class CardDeclinedError extends AppError {
  constructor(readonly reason: string) {
    super('CARD_DECLINED', 402, `Card declined: ${reason}`, { reason });
  }
}

/** Transient provider failure. Safe to retry with the SAME idempotencyKey. */
export class StripeApiError extends AppError {
  constructor(message = 'Stripe is temporarily unavailable. Retry with the same idempotencyKey.') {
    super('STRIPE_ERROR', 502, message);
  }
}

export class LedgerImbalancedError extends AppError {
  constructor(message: string, details?: unknown) {
    super('LEDGER_IMBALANCED', 500, message, details);
  }
}
