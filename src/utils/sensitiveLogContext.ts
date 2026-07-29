import { AsyncLocalStorage } from 'node:async_hooks';

const sensitiveLogSuppression = new AsyncLocalStorage<boolean>();

export function runWithSensitiveLogsSuppressed<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return sensitiveLogSuppression.run(true, operation);
}

export function shouldSuppressSensitiveLogs(): boolean {
  return sensitiveLogSuppression.getStore() === true;
}
