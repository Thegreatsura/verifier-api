export const STATUS_PROVIDERS = [
  'telebirr',
  'cbe',
  'cbe-birr',
  'dashen',
  'abyssinia',
  'mpesa',
] as const;

export type StatusProvider = (typeof STATUS_PROVIDERS)[number];

export type StatusProbeResultCode =
  | 'PROBE_OK'
  | 'UPSTREAM_SLOW'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UNEXPECTED_RESPONSE'
  | 'PROBE_NOT_CONFIGURED';

export interface StatusProbeResult {
  provider: StatusProvider;
  reachable: boolean;
  verificationPathHealthy: boolean;
  durationMs: number;
  checkedAt: string;
  resultCode: StatusProbeResultCode;
}

export interface StatusCapabilities {
  batchVerification: { configured: boolean };
  imageVerification: { configured: boolean };
  hostedCommerce: { configured: boolean };
  checkedAt: string;
}
