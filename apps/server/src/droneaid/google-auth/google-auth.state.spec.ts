import { decodeTransaction, encodeTransaction } from './google-auth.state';
import {
  googleRedirectUri,
  GOOGLE_ISSUER,
  readGoogleAuthConfig,
} from './google-auth.config';

const SECRET = 'test-secret';
const tx = { state: 's', nonce: 'n', codeVerifier: 'v', exp: 2_000 };

describe('OAuth transaction cookie', () => {
  it('round-trips', () => {
    expect(decodeTransaction(encodeTransaction(tx, SECRET), SECRET, 1_000)).toEqual(tx);
  });

  it('rejects a tampered payload', () => {
    const [, sig] = encodeTransaction(tx, SECRET).split('.');
    const forged = Buffer.from(JSON.stringify({ ...tx, state: 'x' })).toString(
      'base64url',
    );
    expect(decodeTransaction(`${forged}.${sig}`, SECRET, 1_000)).toBeNull();
  });

  it('rejects another secret', () => {
    expect(
      decodeTransaction(encodeTransaction(tx, SECRET), 'other', 1_000),
    ).toBeNull();
  });

  it('rejects an expired transaction', () => {
    expect(decodeTransaction(encodeTransaction(tx, SECRET), SECRET, 3_000)).toBeNull();
  });

  it('rejects missing or malformed values', () => {
    expect(decodeTransaction(undefined, SECRET)).toBeNull();
    expect(decodeTransaction('garbage', SECRET)).toBeNull();
    expect(decodeTransaction('.sig', SECRET)).toBeNull();
  });
});

describe('readGoogleAuthConfig', () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];

  it('is off unless both id and secret are set', () => {
    expect(readGoogleAuthConfig(env({}))).toBeNull();
    expect(readGoogleAuthConfig(env({ GOOGLE_CLIENT_ID: 'id' }))).toBeNull();
    expect(
      readGoogleAuthConfig(env({ GOOGLE_CLIENT_ID: ' ', GOOGLE_CLIENT_SECRET: 's' })),
    ).toBeNull();
  });

  it('defaults the issuer to Google', () => {
    expect(
      readGoogleAuthConfig(env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' })),
    ).toEqual({ clientId: 'id', clientSecret: 's', issuer: GOOGLE_ISSUER });
  });

  it('accepts an issuer override', () => {
    expect(
      readGoogleAuthConfig(
        env({
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 's',
          GOOGLE_OIDC_ISSUER: 'http://localhost:8292/default',
        }),
      )?.issuer,
    ).toBe('http://localhost:8292/default');
  });

  it('builds the redirect URI from APP_URL', () => {
    expect(googleRedirectUri('https://base.droneaid.fr/')).toBe(
      'https://base.droneaid.fr/api/droneaid/auth/google/callback',
    );
  });
});
