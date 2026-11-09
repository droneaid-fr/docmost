import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { Space, User, Workspace } from '@docmost/db/types/entity.types';
import { SpaceService } from '../../core/space/services/space.service';
import { SpaceMemberService } from '../../core/space/services/space-member.service';
import { SpaceRole, UserRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { AgentRepo, AgentTokenView } from './agent.repo';
import { DroneaidAgent } from '../db.types';
import {
  displayPrefix,
  generateAgentToken,
  hashAgentToken,
  isWellFormedAgentToken,
} from './agent-token.util';

/** last_used_at is written at most this often per token. */
export const TOKEN_TOUCH_INTERVAL_MS = 60_000;

/**
 * Either a new space (`spaceName` + `spaceSlug`, the original form) or an
 * existing one (`spaceId`), e.g. a space created by the AFFiNE import.
 */
export type CreateAgentInput = {
  name: string;
  email?: string;
  spaceName?: string;
  spaceSlug?: string;
  spaceId?: string;
};

export type AuthenticatedAgent = {
  agent: DroneaidAgent;
  user: User;
  tokenId: string;
};

/**
 * Agent accounts for the MCP endpoint.
 *
 * An agent is an ordinary Docmost user (workspace role `member`) with a row in
 * `droneaid_agents`. It authenticates only with a `dmcp_` token checked by the
 * MCP guard; its password is a random secret nobody knows.
 *
 * The "Everyone" trap: core adds every new user to the undeletable default
 * group, and that group is a writer on "General". An agent is therefore never
 * created through SignupService (the only place, with invitation acceptance,
 * that calls `addUserToDefaultGroup`); it is inserted with `UserRepo` directly
 * and joins no group. If an admin adds it to the default group anyway (the
 * groups API allows that, and core then forbids removing it again),
 * `ensureOutsideDefaultGroup` removes it on the next MCP request.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly agentRepo: AgentRepo,
    private readonly userRepo: UserRepo,
    private readonly spaceService: SpaceService,
    private readonly spaceMemberService: SpaceMemberService,
    private readonly spaceRepo?: SpaceRepo,
  ) {}

  async listAgents(workspaceId: string) {
    const [agents, tokens] = await Promise.all([
      this.agentRepo.listAgents(workspaceId),
      this.agentRepo.listTokens(workspaceId),
    ]);
    return agents.map((agent) => ({
      ...agent,
      tokens: tokens.filter((token) => token.agentUserId === agent.userId),
    }));
  }

  async createAgent(
    admin: User,
    workspace: Workspace,
    input: CreateAgentInput,
  ) {
    const existingSpace = input.spaceId
      ? await this.findBindableSpace(input.spaceId, workspace.id)
      : null;
    if (!existingSpace && !(input.spaceName?.trim() && input.spaceSlug)) {
      throw new BadRequestException(
        'Give either spaceId or both spaceName and spaceSlug',
      );
    }
    const slug = existingSpace?.slug ?? input.spaceSlug;
    const email = (
      input.email?.trim() || `${slug}.agent@agents.invalid`
    ).toLowerCase();
    const existing = await this.userRepo.findByEmail(email, workspace.id);
    if (existing) {
      throw new BadRequestException(
        `A user with email ${email} already exists`,
      );
    }

    return executeTx(this.db, async (trx) => {
      const user = await this.userRepo.insertUser(
        {
          name: input.name.trim(),
          email,
          password: randomBytes(32).toString('base64url'),
          workspaceId: workspace.id,
          role: UserRole.MEMBER,
          hasGeneratedPassword: true,
        },
        trx,
      );

      // A new space: the admin who creates it becomes its admin. Either way
      // the agent writes there.
      const space =
        existingSpace ??
        (await this.spaceService.createSpace(
          admin,
          workspace.id,
          { name: input.spaceName, slug: input.spaceSlug },
          trx,
        ));
      await this.spaceMemberService.addUserToSpace(
        user.id,
        space.id,
        SpaceRole.WRITER,
        workspace.id,
        trx,
      );

      const agent = await this.agentRepo.insertAgent(
        {
          userId: user.id,
          workspaceId: workspace.id,
          spaceId: space.id,
          createdById: admin.id,
        },
        trx,
      );

      return {
        userId: agent.userId,
        name: user.name,
        email: user.email,
        spaceId: space.id,
        spaceName: space.name,
        spaceSlug: space.slug,
      };
    });
  }

  private async findBindableSpace(
    spaceId: string,
    workspaceId: string,
  ): Promise<Space> {
    const space = this.spaceRepo
      ? await this.spaceRepo.findById(spaceId, workspaceId)
      : null;
    if (!space || space.deletedAt) {
      throw new NotFoundException('Space not found');
    }
    return space;
  }

  async mintToken(
    adminId: string,
    workspaceId: string,
    agentUserId: string,
    name: string,
    expiresInDays?: number,
  ): Promise<{ token: string; record: AgentTokenView }> {
    const agent = await this.agentRepo.findAgent(agentUserId, workspaceId);
    if (!agent) throw new NotFoundException('Agent not found');

    const token = generateAgentToken();
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;
    const record = await this.agentRepo.insertToken({
      agentUserId,
      workspaceId,
      name: name.trim(),
      tokenHash: hashAgentToken(token),
      tokenPrefix: displayPrefix(token),
      createdById: adminId,
      expiresAt,
    });
    return { token, record };
  }

  async revokeToken(workspaceId: string, tokenId: string) {
    const revoked = await this.agentRepo.revokeToken(tokenId, workspaceId);
    if (!revoked) throw new NotFoundException('Active token not found');
    return revoked;
  }

  /** Resolves a presented token to its agent, or null if it must be refused. */
  async authenticate(token: string): Promise<AuthenticatedAgent | null> {
    if (!isWellFormedAgentToken(token)) return null;

    const row = await this.agentRepo.findTokenByHash(hashAgentToken(token));
    if (!row || row.revokedAt) return null;
    const now = new Date();
    if (row.expiresAt && new Date(row.expiresAt) <= now) return null;

    const agent = await this.agentRepo.findAgent(
      row.agentUserId,
      row.workspaceId,
    );
    if (!agent) return null;
    const user = await this.userRepo.findById(agent.userId, agent.workspaceId);
    if (!user || isUserDisabled(user)) return null;

    const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (now.getTime() - lastUsed >= TOKEN_TOUCH_INTERVAL_MS) {
      await this.agentRepo.touchToken(row.id, now);
    }

    return { agent, user, tokenId: row.id };
  }

  /**
   * Cheap pre-check (one indexed lookup, no writes) used before the MCP
   * route reads a request body; `authenticate` still runs afterwards.
   */
  async isLiveToken(token: string): Promise<boolean> {
    if (!isWellFormedAgentToken(token)) return false;
    const row = await this.agentRepo.findTokenByHash(hashAgentToken(token));
    if (!row || row.revokedAt) return false;
    return !row.expiresAt || new Date(row.expiresAt) > new Date();
  }

  async isAgent(userId: string, workspaceId: string): Promise<boolean> {
    return !!(await this.agentRepo.findAgent(userId, workspaceId));
  }

  /**
   * Removes the agent from the default group if someone put it there.
   * Returns true when it had to (space-role caches are then stale for up to
   * PERMISSION_CACHE_TTL_MS, so the caller should skip them).
   */
  async ensureOutsideDefaultGroup(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const groupIds = await this.agentRepo.findDefaultGroupMembership(
      userId,
      workspaceId,
    );
    if (groupIds.length === 0) return false;
    await this.agentRepo.removeFromGroups(userId, groupIds);
    this.logger.warn(
      `Agent ${userId} was a member of the default group; removed it so it does not inherit the group's space roles`,
    );
    return true;
  }
}
