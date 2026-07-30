export const STATUS_PROVIDERS = [
  'telebirr',
  'cbe',
  'cbe-new',
  'cbe-birr',
  'dashen',
  'abyssinia',
] as const;

export type StatusProvider = (typeof STATUS_PROVIDERS)[number];

export type StatusProbeResultCode =
  | 'PROBE_OK'
  | 'FALLBACK_ACTIVE'
  | 'UPSTREAM_SLOW'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'ALL_ROUTES_UNAVAILABLE'
  | 'UNEXPECTED_RESPONSE'
  | 'PROBE_NOT_CONFIGURED';

export interface TelebirrRouteStatus {
  id: string;
  label: string;
  role: 'preferred' | 'fallback';
  status: 'operational' | 'unavailable';
  latencyMs: number | null;
}

export interface TelebirrProbeDetails {
  activeRouteId: string | null;
  preferredRouteAvailable: boolean;
  routes: TelebirrRouteStatus[];
}

export interface StatusProbeResult {
  provider: StatusProvider;
  reachable: boolean;
  verificationPathHealthy: boolean;
  durationMs: number;
  checkedAt: string;
  resultCode: StatusProbeResultCode;
  telebirr?: TelebirrProbeDetails;
}

export interface StatusCapabilities {
  batchVerification: { configured: boolean };
  imageVerification: { configured: boolean };
  hostedCommerce: { configured: boolean };
  checkedAt: string;
}
