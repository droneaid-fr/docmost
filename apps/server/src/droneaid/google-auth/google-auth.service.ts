import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'node:crypto';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { sql } from 'kysely';
import {
  User,
  Workspace,
  WorkspaceInvitation,
} from '@docmost/db/types/entity.types';
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
import { SignupRulesService } from '../signup-rules/signup-rules.service';
import { GoogleSignupSetting } from '../signup-rules/google-signup.setting';

export type GoogleSignInResult =
  | { ok: true; authToken: string; userId: string }
  | { ok: false; code: GoogleRefusalCode };

const MAX_NAME_LENGTH = 50;

/**
 * Turns verified Google claims into a Docmost session.
 *
 * The Google link is stored in core's `auth_accounts` (provider_user_id = Google `sub`)
 * against one `auth_providers` row of type `google` per workspace (`GoogleSignupSetting`).
 * Who may sign up is decided by the signup rules (`droneaid/signup-rules`) and that row's
 * `allow_signup`; an address with a pending invitation joins through the invitation.
 * Every new account then gets the space grants of its matching rules.
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
    private readonly signupRules: SignupRulesService,
    private readonly googleSetting: GoogleSignupSetting,
  ) {}

  getOrCreateProvider(workspaceId: string) {
    return this.googleSetting.getOrCreateProvider(workspaceId);
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

    // Only an unknown email needs the signup inputs.
    const isUnknown = !linkedUser && !userByEmail && !!claims.email;
    const allowedByRules = isUnknown
      ? await this.signupRules.isAllowed(claims.email, workspace.id)
      : false;
    const pendingInvitation = isUnknown
      ? await this.findPendingInvitation(claims.email, workspace.id)
      : null;

    const decision = decideGoogleSignIn({
      claims,
      linkedUser,
      userByEmail,
      userByEmailLinkedSub,
      allowSignup: provider.allowSignup,
      allowedByRules,
      pendingInvitation,
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
        await this.signupRules.applyGrants(user, workspace.id);
        return this.startSession(user, workspace.id, true);
      }

      case 'signup_invited': {
        const user = await this.signup(
          decision.email,
          decision.name,
          claims.sub,
          provider.id,
          workspace.id,
          decision.invitationId,
        );
        if (!user) return { ok: false, code: 'signup_disabled' };
        await this.signupRules.applyGrants(user, workspace.id);
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

  private async findPendingInvitation(
    email: string,
    workspaceId: string,
  ): Promise<{ id: string } | null> {
    const invitation = await this.db
      .selectFrom('workspaceInvitations')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where(sql`lower(email)`, '=', email.trim().toLowerCase())
      .where('expiresAt', '>', new Date())
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    return invitation ?? null;
  }

  /**
   * Create the account through core `SignupService` and link Google to it. With an
   * `invitationId`, the account also gets what accepting that invitation would
   * give (its workspace role, its groups, `invitedById`) and the invitation is
   * consumed; returns null if the invitation was used up or expired meanwhile.
   */
  private async signup(
    email: string,
    name: string | undefined,
    sub: string,
    providerId: string,
    workspaceId: string,
    invitationId?: string,
  ): Promise<User | null> {
    return executeTx(this.db, async (trx) => {
      let invitation: Pick<
        WorkspaceInvitation,
        'id' | 'role' | 'groupIds' | 'invitedById'
      > | null = null;
      if (invitationId) {
        invitation =
          (await trx
            .deleteFrom('workspaceInvitations')
            .where('id', '=', invitationId)
            .where('workspaceId', '=', workspaceId)
            .where('expiresAt', '>', new Date())
            .returning(['id', 'role', 'groupIds', 'invitedById'])
            .executeTakeFirst()) ?? null;
        if (!invitation) return null;
      }

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
        .set({
          emailVerifiedAt: new Date(),
          hasGeneratedPassword: true,
          ...(invitation && {
            role: invitation.role,
            invitedById: invitation.invitedById,
          }),
        })
        .where('id', '=', user.id)
        .execute();
      if (invitation) {
        user.role = invitation.role;
        await this.addInvitationGroups(user.id, workspaceId, invitation.groupIds, trx);
      }
      await this.link(user.id, sub, providerId, workspaceId, trx);
      return user;
    });
  }

  /** Same as core invitation acceptance: only groups of this workspace are joined. */
  private async addInvitationGroups(
    userId: string,
    workspaceId: string,
    groupIds: string[] | null,
    trx: KyselyTransaction,
  ): Promise<void> {
    if (!groupIds?.length) return;
    const groups = await trx
      .selectFrom('groups')
      .select(['id'])
      .where('id', 'in', groupIds)
      .where('workspaceId', '=', workspaceId)
      .execute();
    if (!groups.length) return;
    await trx
      .insertInto('groupUsers')
      .values(groups.map((g) => ({ userId, groupId: g.id })))
      .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
      .execute();
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
