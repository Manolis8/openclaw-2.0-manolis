import WebSocket from "ws";

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.startsWith("::ffff:127.");
}

export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  url.pathname = url.pathname.replace(/\/$/, "") + path;
  return url.toString();
}

export async function fetchJson<T>(url: string, timeout = 5000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return null;
    }
    return await res.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchOk(url: string, timeout = 5000): Promise<boolean> {
  return fetchJson<unknown>(url, timeout).then((r) => r !== null);
}

export function getHeadersWithAuth(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let id = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let isClosed = false;

    const cleanup = () => {
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
    };

    const send = async (method: string, params?: unknown): Promise<unknown> => {
      if (isClosed || !ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("CDP socket not connected");
      }
      const msgId = ++id;
      const promise = new Promise<unknown>((res, rej) => {
        pending.set(msgId, { resolve: res, reject: rej });
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return promise;
    };

    try {
      ws = new WebSocket(wsUrl);

      ws.on("open", async () => {
        try {
          const result = await fn(send);
          isClosed = true;
          cleanup();
          resolve(result);
        } catch (err) {
          isClosed = true;
          cleanup();
          reject(err);
        }
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(msg.error.message || "CDP error"));
            } else {
              p.resolve(msg.result);
            }
          }
        } catch {
          // ignore parse errors
        }
      });

      ws.on("error", (err) => {
        if (!isClosed) {
          isClosed = true;
          cleanup();
          reject(err);
        }
      });

      ws.on("close", () => {
        if (!isClosed) {
          isClosed = true;
          cleanup();
          reject(new Error("CDP socket closed unexpectedly"));
        }
      });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}