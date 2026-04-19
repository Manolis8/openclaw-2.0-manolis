export type SsrFPolicy = {
  allowedOrigins?: string[];
  blockedOrigins?: string[];
  allowLoopback?: boolean;
  blockFileUrls?: boolean;
};