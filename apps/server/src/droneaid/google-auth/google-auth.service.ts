import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'node:crypto';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SignupService } from '../../core/auth/services/signup.service';
import { SessionService } from '../../core/session/session.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  decideGoogleSignIn,
  GoogleClaims,
  GoogleRefusalCode,
} from './google-auth.decision';

export type GoogleSignInResult =
  | { ok: true; authToken: string; userId: string }
  | { ok: false; code: GoogleRefusalCode };

const PROVIDER_TYPE = 'google';
const PROVIDER_NAME = 'Google';
const MAX_NAME_LENGTH = 50;

/**
 * Turns verified Google claims into a Docmost session.
 *
 * The Google link is stored in core's `auth_accounts` (provider_user_id = Google `sub`)
 * against one `auth_providers` row of type `google` per workspace, which this module
 * creates on first use. That row's `allow_signup` is the signup switch; `is_enabled`
 * stays false so the row never shows up in the public workspace data that core and the
 * licence-gated client SSO code read.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly signupService: SignupService,
    private readonly sessionService: SessionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async getOrCreateProvider(workspaceId: string) {
    const existing = await this.db
      .selectFrom('authProviders')
      .select(['id', 'allowSignup'])
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', PROVIDER_TYPE)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();
    if (existing) return existing;

    return this.db
      .insertInto('authProviders')
      .values({
        name: PROVIDER_NAME,
        type: PROVIDER_TYPE,
        workspaceId,
        isEnabled: false,
        allowSignup: false,
      })
      .returning(['id', 'allowSignup'])
      .executeTakeFirstOrThrow();
  }

  async signIn(
    claims: GoogleClaims,
    workspace: Workspace,
  ): Promise<GoogleSignInResult> {
    const provider = await this.getOrCreateProvider(workspace.id);

    const linkedUser = await this.findLinkedUser(
      claims.sub,
      provider.id,
      workspace.id,
    );
    const userByEmail =
      !linkedUser && claims.email
        ? await this.userRepo.findByEmail(claims.email, workspace.id)
        : null;
    const userByEmailLinkedSub = userByEmail
      ? await this.findLinkedSub(userByEmail.id, provider.id)
      : null;

    const decision = decideGoogleSignIn({
      claims,
      linkedUser,
      userByEmail,
      userByEmailLinkedSub,
      allowSignup: provider.allowSignup,
      emailDomains: workspace.emailDomains,
    });

    switch (decision.action) {
      case 'refuse':
        this.logger.log(
          `Google sign-in refused (${decision.code}) for ${claims.email ?? claims.sub}`,
        );
        return { ok: false, code: decision.code };

      case 'login':
        return this.startSession(linkedUser as User, workspace.id, false);

      case 'link_and_login':
        await this.link(userByEmail.id, claims.sub, provider.id, workspace.id);
        return this.startSession(userByEmail, workspace.id, false);

      case 'signup': {
        const user = await this.signup(
          decision.email,
          decision.name,
          claims.sub,
          provider.id,
          workspace.id,
        );
        return this.startSession(user, workspace.id, true);
      }
    }
  }

  private async findLinkedUser(
    sub: string,
    providerId: string,
    workspaceId: string,
  ): Promise<User | null> {
    const account = await this.db
      .selectFrom('authAccounts')
      .select(['userId'])
      .where('providerUserId', '=', sub)
      .where('authProviderId', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!account) return null;
    return (await this.userRepo.findById(account.userId, workspaceId)) ?? null;
  }

  private async findLinkedSub(
    userId: string,
    providerId: string,
  ): Promise<string | null> {
    const account = await this.db
      .selectFrom('authAccounts')
      .select(['providerUserId'])
      .where('userId', '=', userId)
      .where('authProviderId', '=', providerId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return account?.providerUserId ?? null;
  }

  private async link(
    userId: string,
    sub: string,
    providerId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .insertInto('authAccounts')
      .values({
        userId,
        providerUserId: sub,
        authProviderId: providerId,
        workspaceId,
      })
      .onConflict((oc) =>
        oc
          .columns(['userId', 'authProviderId'])
          .doUpdateSet({ providerUserId: sub, deletedAt: null }),
      )
      .execute();
  }

  private async signup(
    email: string,
    name: string | undefined,
    sub: string,
    providerId: string,
    workspaceId: string,
  ): Promise<User> {
    return executeTx(this.db, async (trx) => {
      // Core signup: inserts the user, applies the workspace default role and adds
      // the user to the default group. Google users get an unusable random password.
      const user = await this.signupService.signup(
        {
          email,
          name: name?.trim().slice(0, MAX_NAME_LENGTH) || undefined,
          password: randomBytes(32).toString('base64url'),
        },
        workspaceId,
        trx,
      );
      await trx
        .updateTable('users')
        .set({ emailVerifiedAt: new Date(), hasGeneratedPassword: true })
        .where('id', '=', user.id)
        .execute();
      await this.link(user.id, sub, providerId, workspaceId, trx);
      return user;
    });
  }

  private async startSession(
    user: User,
    workspaceId: string,
    isNewUser: boolean,
  ): Promise<GoogleSignInResult> {
    await this.userRepo.updateLastLogin(user.id, workspaceId);
    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'google', isNewUser },
    });
    const authToken = await this.sessionService.createSessionAndToken(user);
    return { ok: true, authToken, userId: user.id };
  }
}
