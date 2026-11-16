// Dev-only guard for the bridge proxies in vite.config.ts. Node side; never bundled.
//
// 🔴 THE PROXY HOLDS THE BEARER TOKEN, SO IT IS THE DOOR. It added the token to
// every request it received and sent none of the caller's Origin on, so the
// bridge's own origin check could not fire. Measured 2026-11-14 against a fake
// printer: a POST from Origin https://evil.example with content-type
// text/plain — a "simple" request, no CORS preflight, which ANY page the founder
// opens can send — uploaded a file through /__printer/v1/upload and started it
// through /__printer/v1/start (state PREPARE). The page cannot read the reply,
// and does not need to: the remote name is computable. A GET is no safer: an
// <img> on another site would pull /__printer/v1/camera.jpg.

/** Why this request is refused, or null when it may pass. */
export function crossSiteRefusal(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const site = one('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return `refused: Sec-Fetch-Site is "${site}" — only this dev server's own pages may reach the bridge`;
  }
  const origin = one('origin');
  if (origin !== undefined) {
    const host = one('host');
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null; // "null" (sandboxed iframe, file:) and garbage alike
    }
    if (!host || originHost !== host) {
      return `refused: Origin "${origin}" is not this dev server (${host ?? 'no Host header'})`;
    }
  }
  return null;
}
