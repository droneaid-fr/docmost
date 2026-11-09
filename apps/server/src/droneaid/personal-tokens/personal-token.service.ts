import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../common/helpers';
import { AgentService } from '../agents/agent.service';
import { PersonalTokenRepo, PersonalTokenView } from './personal-token.repo';
import {
  generatePersonalToken,
  hashPersonalToken,
  isWellFormedPersonalToken,
  personalDisplayPrefix,
} from './personal-token.util';

/** Live (not revoked, not expired) personal tokens a user may hold at once. */
export const MAX_ACTIVE_PERSONAL_TOKENS = 10;
/** last_used_at is written at most this often per token. */
export const PERSONAL_TOKEN_TOUCH_INTERVAL_MS = 60_000;

export type AuthenticatedPerson = {
  user: User;
  workspaceId: string;
  tokenId: string;
};

/**
 * Personal MCP tokens: a human member mints a token for their own MCP client,
 * which then acts as that member with exactly their in-app permissions (the
 * guard builds the same principal as for a session JWT: `isAgent: false`).
 *
 * Every use re-checks the token (revoked, expired) and the user (still in the
 * token's workspace, not deactivated or removed, not an agent account). A
 * removed or deactivated member's tokens therefore stop working at once
 * without being revoked; they work again only if the member is reactivated.
 */
@Injectable()
export class PersonalTokenService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: PersonalTokenRepo,
    private readonly userRepo: UserRepo,
    private readonly agentService: AgentService,
  ) {}

  /** Whether this user may hold personal tokens at all (agents may not). */
  async isAllowed(userId: string, workspaceId: string): Promise<boolean> {
    return !(await this.agentService.isAgent(userId, workspaceId));
  }

  async list(userId: string, workspaceId: string) {
    const allowed = await this.isAllowed(userId, workspaceId);
    const tokens = allowed
      ? await this.repo.listForUser(userId, workspaceId)
      : [];
    return { allowed, maxActive: MAX_ACTIVE_PERSONAL_TOKENS, tokens };
  }

  async create(
    userId: string,
    workspaceId: string,
    name: string,
    expiresInDays?: number,
  ): Promise<{ token: string; record: PersonalTokenView }> {
    if (!(await this.isAllowed(userId, workspaceId))) {
      throw new ForbiddenException(
        'Agent accounts cannot create personal MCP tokens',
      );
    }
    const token = generatePersonalToken();
    const now = new Date();
    const expiresAt = expiresInDays
      ? new Date(now.getTime() + expiresInDays * 86_400_000)
      : null;

    const record = await executeTx(this.db, async (trx) => {
      await this.repo.lockUser(userId, trx);
      const active = await this.repo.countActive(
        userId,
        workspaceId,
        now,
        trx,
      );
      if (active >= MAX_ACTIVE_PERSONAL_TOKENS) {
        throw new BadRequestException(
          `You already have ${MAX_ACTIVE_PERSONAL_TOKENS} active tokens; revoke one first`,
        );
      }
      return this.repo.insert(
        {
          userId,
          workspaceId,
          name: name.trim(),
          tokenHash: hashPersonalToken(token),
          tokenPrefix: personalDisplayPrefix(token),
          expiresAt,
        },
        trx,
      );
    });
    return { token, record };
  }

  /** Revokes one of the caller's own live tokens; anyone else's is a 404. */
  async revoke(userId: string, workspaceId: string, tokenId: string) {
    const revoked = await this.repo.revokeForUser(tokenId, userId, workspaceId);
    if (!revoked) throw new NotFoundException('Active token not found');
    return revoked;
  }

  /** Resolves a presented token to its user, or null if it must be refused. */
  async authenticate(token: string): Promise<AuthenticatedPerson | null> {
    const row = await this.findLiveRow(token);
    if (!row) return null;

    const user = await this.userRepo.findById(row.userId, row.workspaceId);
    if (!user || isUserDisabled(user)) return null;
    if (await this.agentService.isAgent(user.id, row.workspaceId)) return null;

    const now = Date.now();
    const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (now - lastUsed >= PERSONAL_TOKEN_TOUCH_INTERVAL_MS) {
      await this.repo.touch(row.id, new Date(now));
    }
    return { user, workspaceId: row.workspaceId, tokenId: row.id };
  }

  /**
   * Cheap pre-check (one indexed lookup, no writes) used before the MCP
   * route reads a request body; `authenticate` still runs afterwards.
   */
  async isLiveToken(token: string): Promise<boolean> {
    return !!(await this.findLiveRow(token));
  }

  private async findLiveRow(token: string) {
    if (!isWellFormedPersonalToken(token)) return null;
    const row = await this.repo.findByHash(hashPersonalToken(token));
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt) <= new Date()) return null;
    return row;
  }
}
