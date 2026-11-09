import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { SpaceMemberService } from '../../core/space/services/space-member.service';
import { DroneaidSignupRule } from '../db.types';
import { SignupRulesRepo } from './signup-rules.repo';
import { GoogleSignupSetting } from './google-signup.setting';
import {
  isAllowedByRules,
  normalizePattern,
  PatternProblem,
  resolveSpaceGrants,
  SpaceGrantRole,
  validateRules,
} from './signup-rules.matcher';

export interface SignupRuleInput {
  id?: string;
  pattern: string;
  spaceIds: string[];
  spaceRole: SpaceGrantRole;
}

export interface SignupRuleView {
  id: string;
  pattern: string;
  spaceIds: string[];
  spaceRole: string;
  createdAt: Date;
  updatedAt: Date;
}

export type GrantOutcome = {
  spaceId: string;
  role: SpaceGrantRole;
  result: 'added' | 'already_member' | 'space_missing' | 'failed';
};

const PROBLEM_TEXT: Record<PatternProblem, string> = {
  empty: 'needs a domain or address',
  whitespace: 'contains spaces',
  address_wildcard: 'wildcards are not supported inside an address',
  address_incomplete: 'an address needs a name and a domain around the @',
  wildcard_no_domain: 'a wildcard needs a domain after "*."',
  misplaced_wildcard: 'a wildcard is only recognised as a leading "*."',
};

function toView(rule: DroneaidSignupRule): SignupRuleView {
  return {
    id: rule.id,
    pattern: rule.pattern,
    spaceIds: rule.spaceIds ?? [],
    spaceRole: rule.spaceRole,
    createdAt: rule.createdAt as unknown as Date,
    updatedAt: rule.updatedAt as unknown as Date,
  };
}

/**
 * Signup allowlist rules: who may create an account through Google, and which
 * spaces a newly created account joins.
 *
 * Source of truth: these rules decide self-signup on our Google path. Core
 * `workspaces.email_domains` is neither synced nor read there; it keeps gating
 * core invitation acceptance only (and, for the same reason, our Google path for
 * invitees). Space grants apply to every new account that matches a rule,
 * whichever path created it, and only at creation.
 */
@Injectable()
export class SignupRulesService {
  private readonly logger = new Logger(SignupRulesService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: SignupRulesRepo,
    private readonly googleSetting: GoogleSignupSetting,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceMemberService: SpaceMemberService,
  ) {}

  async listRules(workspaceId: string): Promise<SignupRuleView[]> {
    return (await this.repo.listByWorkspace(workspaceId)).map(toView);
  }

  /**
   * Replace the workspace's rule list with `input` (the admin form saves the whole
   * list). Rules keep their id and createdAt when the client sends the id back.
   */
  async saveRules(
    workspaceId: string,
    input: SignupRuleInput[],
    allowGoogleSignup: boolean,
  ): Promise<void> {
    const problem = validateRules(input);
    if (problem) {
      const label = problem.pattern.trim()
        ? `"${problem.pattern.trim()}"`
        : `Rule ${problem.index + 1}`;
      throw new BadRequestException(
        `${label} can never match an address: ${PROBLEM_TEXT[problem.problem]}.`,
      );
    }

    await executeTx(this.db, async (trx) => {
      const existing = await this.repo.listByWorkspace(workspaceId, trx);
      const byId = new Map(existing.map((r) => [r.id, r]));
      const kept = new Set<string>();

      for (const rule of input) {
        const values = {
          pattern: normalizePattern(rule.pattern),
          spaceIds: [...new Set(rule.spaceIds)],
          spaceRole: rule.spaceRole,
        };
        const current = rule.id ? byId.get(rule.id) : undefined;
        if (current && !kept.has(current.id)) {
          kept.add(current.id);
          const unchanged =
            current.pattern === values.pattern &&
            current.spaceRole === values.spaceRole &&
            JSON.stringify(current.spaceIds ?? []) ===
              JSON.stringify(values.spaceIds);
          if (!unchanged) {
            await this.repo.update(workspaceId, current.id, values, trx);
          }
        } else {
          await this.repo.insert(workspaceId, values, trx);
        }
      }

      await this.repo.deleteByIds(
        workspaceId,
        existing.filter((r) => !kept.has(r.id)).map((r) => r.id),
        trx,
      );
      await this.googleSetting.setSignupAllowed(
        workspaceId,
        allowGoogleSignup,
        trx,
      );
    });
  }

  async isAllowed(email: string, workspaceId: string): Promise<boolean> {
    return isAllowedByRules(email, await this.repo.listByWorkspace(workspaceId));
  }

  /**
   * Add a newly created account to the spaces its matching rules grant.
   * Never throws: a grant must not fail the signup that triggered it. A space
   * that no longer exists is logged and skipped. Idempotent: an existing
   * membership is left as it is.
   */
  async applyGrants(
    user: { id: string; email: string },
    workspaceId: string,
  ): Promise<GrantOutcome[]> {
    let grants: ReturnType<typeof resolveSpaceGrants>;
    try {
      grants = resolveSpaceGrants(
        user.email,
        await this.repo.listByWorkspace(workspaceId),
      );
    } catch (err) {
      this.logger.error(`Could not load signup rules for ${user.id}`, err);
      return [];
    }

    const outcomes: GrantOutcome[] = [];
    for (const grant of grants) {
      outcomes.push({
        ...grant,
        result: await this.applyGrant(user.id, workspaceId, grant),
      });
    }
    return outcomes;
  }

  private async applyGrant(
    userId: string,
    workspaceId: string,
    grant: { spaceId: string; role: SpaceGrantRole },
  ): Promise<GrantOutcome['result']> {
    try {
      const space = await this.spaceRepo.findById(grant.spaceId, workspaceId);
      if (!space || space.deletedAt) {
        this.logger.warn(
          `Signup grant skipped: space ${grant.spaceId} no longer exists (user ${userId})`,
        );
        return 'space_missing';
      }
      const member = await this.spaceMemberRepo.getSpaceMemberByTypeId(
        grant.spaceId,
        { userId },
      );
      if (member) return 'already_member';

      await this.spaceMemberService.addUserToSpace(
        userId,
        grant.spaceId,
        grant.role,
        workspaceId,
      );
      return 'added';
    } catch (err: any) {
      // A concurrent run inserted the same membership first: same end state.
      if (String(err?.message ?? '').includes('unique')) return 'already_member';
      this.logger.error(
        `Signup grant failed: space ${grant.spaceId}, user ${userId}`,
        err,
      );
      return 'failed';
    }
  }
}
