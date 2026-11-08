/**
 * Google sign-in configuration, read from env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  both required; if either is unset the feature is off.
 *   GOOGLE_OIDC_ISSUER                      optional issuer override, for tests against a mock
 *                                           OIDC provider. Default: https://accounts.google.com
 */

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_AUTH_BASE_PATH = '/api/droneaid/auth/google';
export const GOOGLE_CALLBACK_PATH = `${GOOGLE_AUTH_BASE_PATH}/callback`;

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
}

type EnvGetter = (key: string) => string | undefined;

export function readGoogleAuthConfig(get: EnvGetter): GoogleAuthConfig | null {
  const clientId = get('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = get('GOOGLE_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;

  const issuer = get('GOOGLE_OIDC_ISSUER')?.trim() || GOOGLE_ISSUER;
  return { clientId, clientSecret, issuer };
}

export function googleRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${GOOGLE_CALLBACK_PATH}`;
}
