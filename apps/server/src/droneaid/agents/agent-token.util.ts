import { createHash, randomBytes } from 'node:crypto';

/**
 * Agent tokens are `dmcp_<43 base64url chars>` (32 random bytes). Only the
 * sha256 hash is stored; the prefix kept for display is not enough to guess
 * the rest. The `dmcp_` marker lets the MCP guard tell an agent token from a
 * session JWT without a database round trip, and is never a valid JWT, so the
 * core JwtStrategy rejects it on every other route.
 */
export const AGENT_TOKEN_PREFIX = 'dmcp_';
const TOKEN_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = AGENT_TOKEN_PREFIX.length + 6;
const TOKEN_PATTERN = /^dmcp_[A-Za-z0-9_-]{43}$/;

export function generateAgentToken(): string {
  return AGENT_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isAgentToken(token: string | undefined): boolean {
  return !!token && token.startsWith(AGENT_TOKEN_PREFIX);
}

export function isWellFormedAgentToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function displayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}
