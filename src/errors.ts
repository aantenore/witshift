export const ExitCode = {
  success: 0,
  invalidArguments: 2,
  invalidConfiguration: 3,
  unsupportedProject: 4,
  toolchainFailure: 5,
  verificationMismatch: 6,
  ioFailure: 7,
  internalFailure: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class WitshiftError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: ExitCodeValue,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WitshiftError';
  }
}

export function asWitshiftError(error: unknown): WitshiftError {
  if (error instanceof WitshiftError) return error;
  const message = error instanceof Error ? error.message : 'Unknown failure';
  return new WitshiftError('INTERNAL_FAILURE', message, ExitCode.internalFailure, undefined, {
    cause: error,
  });
}
