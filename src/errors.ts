const RED = '\u001b[31m';
const RESET = '\u001b[0m';

export class GitMarkError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 1, cause?: unknown) {
    super(message, { cause });
    this.name = 'GitMarkError';
    this.code = code;
    this.status = status;
  }
}

export function isGitMarkError(error: unknown): error is GitMarkError {
  return error instanceof GitMarkError;
}

export function formatRedError(error: unknown): string {
  if (isGitMarkError(error)) {
    return `${RED}error:${RESET} ${error.message}`;
  }
  if (error instanceof Error) {
    return `${RED}error:${RESET} ${error.message}`;
  }
  return `${RED}error:${RESET} ${String(error)}`;
}

export function redText(text: string): string {
  return `${RED}${text}${RESET}`;
}

