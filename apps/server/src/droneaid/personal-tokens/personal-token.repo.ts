import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { DroneaidDB, DroneaidUserMcpToken, droneaidDb } from '../db.types';

export type PersonalTokenView = Omit<DroneaidUserMcpToken, 'tokenHash'>;

const VIEW_FIELDS = [
  'id',
  'userId',
  'workspaceId',
  'name',
  'tokenPrefix',
  'createdAt',
  'expiresAt',
  'lastUsedAt',
  'revokedAt',
] as const;

@Injectable()
export class PersonalTokenRepo {
  private readonly db: DroneaidDB;

  constructor(@InjectKysely() db: KyselyDB) {
    this.db = droneaidDb(db);
  }

  private q(trx?: KyselyTransaction): DroneaidDB {
    return droneaidDb(dbOrTx(this.db as unknown as KyselyDB, trx));
  }

  /**
   * Serialises token creation per user (row lock on `users`), so two
   * concurrent requests cannot both pass the active-token cap.
   */
  async lockUser(userId: string, trx: KyselyTransaction): Promise<void> {
    await this.q(trx)
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .forUpdate()
      .execute();
  }

  async countActive(
    userId: string,
    workspaceId: string,
    now: Date,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const row = await this.q(trx)
      .selectFrom('droneaidUserMcpTokens')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)]),
      )
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async insert(
    token: {
      userId: string;
      workspaceId: string;
      name: string;
      tokenHash: string;
      tokenPrefix: string;
      expiresAt: Date | null;
    },
    trx?: KyselyTransaction,
  ): Promise<PersonalTokenView> {
    return this.q(trx)
      .insertInto('droneaidUserMcpTokens')
      .values(token)
      .returning(VIEW_FIELDS)
      .executeTakeFirstOrThrow();
  }

  async listForUser(
    userId: string,
    workspaceId: string,
  ): Promise<PersonalTokenView[]> {
    return this.db
      .selectFrom('droneaidUserMcpTokens')
      .select(VIEW_FIELDS)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async findByHash(
    tokenHash: string,
  ): Promise<DroneaidUserMcpToken | undefined> {
    return this.db
      .selectFrom('droneaidUserMcpTokens')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .executeTakeFirst();
  }

  /** Revokes only a live token that belongs to this user in this workspace. */
  async revokeForUser(
    tokenId: string,
    userId: string,
    workspaceId: string,
  ): Promise<PersonalTokenView | undefined> {
    return this.db
      .updateTable('droneaidUserMcpTokens')
      .set({ revokedAt: new Date() })
      .where('id', '=', tokenId)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .returning(VIEW_FIELDS)
      .executeTakeFirst();
  }

  async touch(tokenId: string, at: Date): Promise<void> {
    await this.db
      .updateTable('droneaidUserMcpTokens')
      .set({ lastUsedAt: at })
      .where('id', '=', tokenId)
      .execute();
  }
}
