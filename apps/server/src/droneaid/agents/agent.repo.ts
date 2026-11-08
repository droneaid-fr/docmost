import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import {
  DroneaidAgent,
  DroneaidAgentToken,
  DroneaidDB,
  droneaidDb,
} from '../db.types';

export type AgentListRow = {
  userId: string;
  name: string | null;
  email: string;
  deactivatedAt: Date | null;
  spaceId: string | null;
  spaceName: string | null;
  spaceSlug: string | null;
  createdAt: Date;
};

export type AgentTokenView = Omit<DroneaidAgentToken, 'tokenHash'>;

const TOKEN_VIEW_FIELDS = [
  'id',
  'agentUserId',
  'workspaceId',
  'name',
  'tokenPrefix',
  'createdById',
  'createdAt',
  'expiresAt',
  'lastUsedAt',
  'revokedAt',
] as const;

@Injectable()
export class AgentRepo {
  private readonly db: DroneaidDB;

  constructor(@InjectKysely() db: KyselyDB) {
    this.db = droneaidDb(db);
  }

  private q(trx?: KyselyTransaction): DroneaidDB {
    return droneaidDb(dbOrTx(this.db as unknown as KyselyDB, trx));
  }

  async insertAgent(
    agent: {
      userId: string;
      workspaceId: string;
      spaceId: string | null;
      createdById: string | null;
    },
    trx?: KyselyTransaction,
  ): Promise<DroneaidAgent> {
    return this.q(trx)
      .insertInto('droneaidAgents')
      .values(agent)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findAgent(
    userId: string,
    workspaceId: string,
  ): Promise<DroneaidAgent | undefined> {
    return this.db
      .selectFrom('droneaidAgents')
      .selectAll()
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async listAgents(workspaceId: string): Promise<AgentListRow[]> {
    return this.db
      .selectFrom('droneaidAgents')
      .innerJoin('users', 'users.id', 'droneaidAgents.userId')
      .leftJoin('spaces', 'spaces.id', 'droneaidAgents.spaceId')
      .select([
        'droneaidAgents.userId',
        'users.name',
        'users.email',
        'users.deactivatedAt',
        'droneaidAgents.spaceId',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
        'droneaidAgents.createdAt',
      ])
      .where('droneaidAgents.workspaceId', '=', workspaceId)
      .orderBy('droneaidAgents.createdAt', 'asc')
      .execute();
  }

  async insertToken(token: {
    agentUserId: string;
    workspaceId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    createdById: string | null;
    expiresAt: Date | null;
  }): Promise<AgentTokenView> {
    return this.db
      .insertInto('droneaidAgentTokens')
      .values(token)
      .returning(TOKEN_VIEW_FIELDS)
      .executeTakeFirstOrThrow();
  }

  async listTokens(workspaceId: string): Promise<AgentTokenView[]> {
    return this.db
      .selectFrom('droneaidAgentTokens')
      .select(TOKEN_VIEW_FIELDS)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async findTokenByHash(
    tokenHash: string,
  ): Promise<DroneaidAgentToken | undefined> {
    return this.db
      .selectFrom('droneaidAgentTokens')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .executeTakeFirst();
  }

  async revokeToken(
    tokenId: string,
    workspaceId: string,
  ): Promise<AgentTokenView | undefined> {
    return this.db
      .updateTable('droneaidAgentTokens')
      .set({ revokedAt: new Date() })
      .where('id', '=', tokenId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .returning(TOKEN_VIEW_FIELDS)
      .executeTakeFirst();
  }

  async touchToken(tokenId: string, at: Date): Promise<void> {
    await this.db
      .updateTable('droneaidAgentTokens')
      .set({ lastUsedAt: at })
      .where('id', '=', tokenId)
      .execute();
  }

  /** Default-group ("Everyone") memberships of a user; see AgentService. */
  async findDefaultGroupMembership(
    userId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom('groupUsers')
      .innerJoin('groups', 'groups.id', 'groupUsers.groupId')
      .select('groups.id')
      .where('groupUsers.userId', '=', userId)
      .where('groups.workspaceId', '=', workspaceId)
      .where('groups.isDefault', '=', true)
      .execute();
    return rows.map((row) => row.id);
  }

  async removeFromGroups(userId: string, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.db
      .deleteFrom('groupUsers')
      .where('userId', '=', userId)
      .where('groupId', 'in', groupIds)
      .execute();
  }
}
