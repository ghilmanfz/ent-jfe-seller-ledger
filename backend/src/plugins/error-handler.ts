import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

/**
 * One JSON error envelope for everything: { error: { code, message, details? } }.
 * AppError carries its own HTTP status; ZodError maps to 400; anything else is
 * a logged 500 with no internals leaked to the client.
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error }, error.message);
    } else {
      request.log.info({ code: error.code }, error.message);
    }
    void reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (statusCode < 500) {
    // Fastify-level client errors (malformed JSON body, oversized payload, ...)
    void reply.status(statusCode).send({
      error: { code: 'VALIDATION_ERROR', message: error.message },
    });
    return;
  }

  request.log.error({ err: error }, 'Unhandled error');
  void reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
  });
}
