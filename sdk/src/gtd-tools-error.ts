export interface GTDToolsErrorClassification {
  kind: 'timeout' | 'failure';
  timeoutMs?: number;
}

function timeoutClassification(timeoutMs?: number): GTDToolsErrorClassification {
  return timeoutMs === undefined ? { kind: 'timeout' } : { kind: 'timeout', timeoutMs };
}

function failureClassification(): GTDToolsErrorClassification {
  return { kind: 'failure' };
}

export class GTDToolsError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
    options?: { cause?: unknown; classification?: GTDToolsErrorClassification },
  ) {
    super(message, options);
    this.name = 'GTDToolsError';
    this.classification = options?.classification ?? failureClassification();
  }

  static timeout(
    message: string,
    command: string,
    args: string[],
    stderr = '',
    timeoutMs?: number,
    options?: { cause?: unknown; exitCode?: number | null },
  ): GTDToolsError {
    return new GTDToolsError(
      message,
      command,
      args,
      options?.exitCode ?? null,
      stderr,
      { cause: options?.cause, classification: timeoutClassification(timeoutMs) },
    );
  }

  static failure(
    message: string,
    command: string,
    args: string[],
    exitCode: number | null,
    stderr = '',
    options?: { cause?: unknown },
  ): GTDToolsError {
    return new GTDToolsError(
      message,
      command,
      args,
      exitCode,
      stderr,
      { cause: options?.cause, classification: failureClassification() },
    );
  }

  public readonly classification: GTDToolsErrorClassification;
}
