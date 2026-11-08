import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The OAuth transaction (state, nonce, PKCE verifier) lives in a short-lived,
 * HMAC-signed, httpOnly cookie between the start route and the callback.
 * Nothing is stored server-side.
 */

export const STATE_COOKIE_NAME = 'droneaid_google_oauth';
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', `droneaid-google-oauth:${secret}`)
    .update(payload)
    .digest('base64url');
}

export function encodeTransaction(
  tx: OAuthTransaction,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(tx)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the transaction, or null if the cookie is missing, forged or expired. */
export function decodeTransaction(
  value: string | undefined,
  secret: string,
  now: number = Date.now(),
): OAuthTransaction | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;

  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  try {
    const tx = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof tx?.state !== 'string' ||
      typeof tx?.nonce !== 'string' ||
      typeof tx?.codeVerifier !== 'string' ||
      typeof tx?.exp !== 'number' ||
      tx.exp < now
    ) {
      return null;
    }
    return tx as OAuthTransaction;
  } catch {
    return null;
  }
}
