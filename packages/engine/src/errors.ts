export type EngineErrorCode = 'invalid_state' | 'not_found' | 'forbidden' | 'validation' | 'rate_limited';

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: EngineErrorCode = 'invalid_state',
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export function invalidState(message: string): EngineError {
  return new EngineError(message, 'invalid_state');
}

export function notFound(message: string): EngineError {
  return new EngineError(message, 'not_found');
}

export function validationError(message: string): EngineError {
  return new EngineError(message, 'validation');
}
