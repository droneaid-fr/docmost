import { Injectable, Logger } from '@nestjs/common';
import * as oidc from 'openid-client';
import { GoogleAuthConfig } from './google-auth.config';
import { GoogleClaims } from './google-auth.decision';

export interface AuthorizationStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Thin wrapper over openid-client: discovery (cached), the authorization URL
 * with state, nonce and PKCE (S256), and the code exchange with ID-token checks.
 */
@Injectable()
export class GoogleOidcClient {
  private readonly logger = new Logger(GoogleOidcClient.name);
  private configPromise: Promise<oidc.Configuration> | null = null;

  private discover(cfg: GoogleAuthConfig): Promise<oidc.Configuration> {
    if (!this.configPromise) {
      const issuer = new URL(cfg.issuer);
      // Plain http is only ever used for a local mock issuer in tests.
      const execute =
        issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [];
      this.configPromise = oidc
        .discovery(issuer, cfg.clientId, cfg.clientSecret, undefined, {
          execute,
        })
        .catch((err) => {
          this.configPromise = null;
          this.logger.error(`OIDC discovery failed for ${cfg.issuer}`, err);
          throw err;
        });
    }
    return this.configPromise;
  }

  async start(
    cfg: GoogleAuthConfig,
    redirectUri: string,
  ): Promise<AuthorizationStart> {
    const config = await this.discover(cfg);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });

    return { url: url.href, state, nonce, codeVerifier };
  }

  /**
   * Exchanges the code and returns the validated ID-token claims.
   * `callbackUrl` is the redirect URI plus the query string Google sent back.
   */
  async finish(
    cfg: GoogleAuthConfig,
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<GoogleClaims> {
    const config = await this.discover(cfg);
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error('ID token has no subject');
    }
    return {
      sub: String(claims.sub),
      email: typeof claims.email === 'string' ? claims.email : undefined,
      email_verified: claims.email_verified as boolean | string | undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }
}
