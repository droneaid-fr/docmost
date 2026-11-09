import { createHash, randomBytes } from 'node:crypto';

/**
 * Personal MCP tokens are `dmcpu_<43 base64url chars>` (32 random bytes).
 * They let a human member's own MCP client act as that member. The marker is
 * distinct from agent tokens (`dmcp_`): `dmcpu_` does not start with `dmcp_`,
 * so `isAgentToken` never matches one, and McpAuthGuard routes each kind to
 * its own table without a database round trip. Neither is a JWT, so core's
 * JwtStrategy rejects both on every other route. Only the sha256 hash is
 * stored; the display prefix is not enough to guess the rest.
 */
export const PERSONAL_TOKEN_PREFIX = 'dmcpu_';
const TOKEN_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = PERSONAL_TOKEN_PREFIX.length + 6;
const TOKEN_PATTERN = /^dmcpu_[A-Za-z0-9_-]{43}$/;

export function generatePersonalToken(): string {
  return PERSONAL_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isPersonalToken(token: string | undefined): boolean {
  return !!token && token.startsWith(PERSONAL_TOKEN_PREFIX);
}

export function isWellFormedPersonalToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function hashPersonalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function personalDisplayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}
