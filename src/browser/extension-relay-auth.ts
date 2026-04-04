import { createHmac } from "node:crypto";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
const OPENCLAW_RELAY_BROWSER = "OpenClaw/extension-relay";

class SecretRefUnavailableError extends Error {
  readonly isSecretRefUnavailable = true;
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveGatewayAuthToken(): Promise<string | null> {
  return process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || null
}

function deriveRelayAuthToken(gatewayToken: string, port: number): string {
  return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

export async function resolveRelayAcceptedTokensForPort(port: number): Promise<string[]> {
  const gatewayToken = await resolveGatewayAuthToken();
  if (!gatewayToken) {
    throw new Error(
      "extension relay requires gateway auth token (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  const relayToken = deriveRelayAuthToken(gatewayToken, port);
  if (relayToken === gatewayToken) {
    return [relayToken];
  }
  return [relayToken, gatewayToken];
}

export async function resolveRelayAuthTokenForPort(port: number): Promise<string> {
  return (await resolveRelayAcceptedTokensForPort(port))[0];
}

export async function probeAuthenticatedOpenClawRelay(params: {
  baseUrl: string;
  relayAuthHeader: string;
  relayAuthToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS);
  try {
    const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: { [params.relayAuthHeader]: params.relayAuthToken },
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { Browser?: unknown };
    const browserName = typeof body?.Browser === "string" ? body.Browser.trim() : "";
    return browserName === OPENCLAW_RELAY_BROWSER;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
