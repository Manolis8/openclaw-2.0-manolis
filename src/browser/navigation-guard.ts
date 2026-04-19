import type { SsrFPolicy } from "../infra/net/ssrf.js";

export async function assertBrowserNavigationAllowed(opts: {
  url: string;
  allowedOrigins?: string[];
  blockedOrigins?: string[];
  allowLoopback?: boolean;
  blockFileUrls?: boolean;
}): Promise<void> {
  try {
    const url = new URL(opts.url);
    
    if (opts.blockFileUrls && url.protocol === "file:") {
      throw new Error("Navigation to file: URLs is blocked");
    }
    
    if (opts.blockedOrigins?.includes(url.origin)) {
      throw new Error(`Navigation to ${url.origin} is blocked`);
    }
    
    if (opts.allowedOrigins?.length && !opts.allowedOrigins.includes(url.origin)) {
      throw new Error(`Navigation to ${url.origin} is not allowed`);
    }
    
    if (opts.allowLoopback === false) {
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
        throw new Error("Loopback navigation is blocked");
      }
    }
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Invalid URL");
  }
}

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): { allowedOrigins?: string[]; blockedOrigins?: string[]; allowLoopback?: boolean; blockFileUrls?: boolean } {
  if (!ssrfPolicy) {
    return {};
  }
  return {
    allowedOrigins: ssrfPolicy.allowedOrigins,
    blockedOrigins: ssrfPolicy.blockedOrigins,
    allowLoopback: ssrfPolicy.allowLoopback,
    blockFileUrls: ssrfPolicy.blockFileUrls,
  };
}