import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import {
  GOOGLE_AUTH_BASE_PATH,
  googleRedirectUri,
  GoogleAuthConfig,
  readGoogleAuthConfig,
} from './google-auth.config';
import {
  decodeTransaction,
  encodeTransaction,
  STATE_COOKIE_NAME,
  STATE_TTL_MS,
} from './google-auth.state';
import { GoogleOidcClient } from './google-oidc.client';
import { GoogleAuthService } from './google-auth.service';
import { GoogleRefusalCode } from './google-auth.decision';

/**
 * Error codes the login page understands (`/login?google_error=<code>`): these plus
 * every `GoogleRefusalCode`.
 */
type ErrorCode =
  | GoogleRefusalCode
  | 'not_configured'
  | 'state_mismatch'
  | 'cancelled'
  | 'failed';

/**
 * Routes (all public, under the global `/api` prefix):
 *   GET /api/droneaid/auth/google/config    -> { enabled } for the login button
 *   GET /api/droneaid/auth/google           -> 302 to Google (state, nonce, PKCE)
 *   GET /api/droneaid/auth/google/callback  -> 302 to /home with the authToken cookie,
 *                                              or to /login?google_error=<code>
 */
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
@Controller('droneaid/auth/google')
export class GoogleAuthController {
  private readonly logger = new Logger(GoogleAuthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly environmentService: EnvironmentService,
    private readonly oidcClient: GoogleOidcClient,
    private readonly googleAuthService: GoogleAuthService,
  ) {}

  private get config(): GoogleAuthConfig | null {
    return readGoogleAuthConfig((key) => this.configService.get<string>(key));
  }

  @SkipThrottle({ [AUTH_THROTTLER]: true })
  @HttpCode(HttpStatus.OK)
  @Get('config')
  getConfig() {
    return { enabled: this.config !== null };
  }

  // Only the callback counts against the auth throttler (10/min per IP, as login).
  @SkipThrottle({ [AUTH_THROTTLER]: true })
  @Get()
  async start(@Res() res: FastifyReply) {
    const cfg = this.config;
    if (!cfg) return this.fail(res, 'not_configured');

    try {
      const appUrl = this.environmentService.getAppUrl();
      const auth = await this.oidcClient.start(cfg, googleRedirectUri(appUrl));
      const cookie = encodeTransaction(
        {
          state: auth.state,
          nonce: auth.nonce,
          codeVerifier: auth.codeVerifier,
          exp: Date.now() + STATE_TTL_MS,
        },
        this.environmentService.getAppSecret(),
      );
      res.setCookie(STATE_COOKIE_NAME, cookie, {
        httpOnly: true,
        sameSite: 'lax',
        path: GOOGLE_AUTH_BASE_PATH,
        maxAge: STATE_TTL_MS / 1000,
        secure: this.environmentService.isHttps(),
      });
      return res.redirect(auth.url, 302);
    } catch (err) {
      this.logger.error('Could not start Google sign-in', err);
      return this.fail(res, 'failed');
    }
  }

  @Get('callback')
  async callback(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const cfg = this.config;
    if (!cfg) return this.fail(res, 'not_configured');

    const tx = decodeTransaction(
      req.cookies?.[STATE_COOKIE_NAME],
      this.environmentService.getAppSecret(),
    );
    res.clearCookie(STATE_COOKIE_NAME, { path: GOOGLE_AUTH_BASE_PATH });
    if (!tx) return this.fail(res, 'state_mismatch');

    const query = (req.query ?? {}) as Record<string, string>;
    if (query.error) {
      // The user cancelled, or Google refused the request.
      return this.fail(res, query.error === 'access_denied' ? 'cancelled' : 'failed');
    }

    if (query.state !== tx.state) return this.fail(res, 'state_mismatch');

    // Rebuild the callback URL from APP_URL (not the Host header) plus Google's query.
    const appUrl = this.environmentService.getAppUrl();
    const search = req.url.includes('?')
      ? req.url.slice(req.url.indexOf('?'))
      : '';
    const callbackUrl = new URL(googleRedirectUri(appUrl) + search);

    let claims;
    try {
      claims = await this.oidcClient.finish(cfg, callbackUrl, tx);
    } catch (err: any) {
      this.logger.warn(`Google code exchange failed: ${err?.message ?? err}`);
      return this.fail(res, 'failed');
    }

    try {
      const result = await this.googleAuthService.signIn(claims, workspace);
      if ('code' in result) return this.fail(res, result.code);

      res.setCookie('authToken', result.authToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: this.environmentService.getCookieExpiresIn(),
        secure: this.environmentService.isHttps(),
      });
      return res.redirect(`${appUrl}/home`, 302);
    } catch (err) {
      this.logger.error('Google sign-in failed', err);
      return this.fail(res, 'failed');
    }
  }

  private fail(res: FastifyReply, code: ErrorCode) {
    const appUrl = this.environmentService.getAppUrl();
    return res.redirect(
      `${appUrl}/login?google_error=${encodeURIComponent(code)}`,
      302,
    );
  }
}
