import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { DroneaidDB, droneaidDb, DroneaidSignupRule } from '../db.types';

export interface SignupRuleValues {
  pattern: string;
  spaceIds: string[];
  spaceRole: string;
}

@Injectable()
export class SignupRulesRepo {
  private readonly db: DroneaidDB;

  constructor(@InjectKysely() db: KyselyDB) {
    this.db = droneaidDb(db);
  }

  private q(trx?: KyselyTransaction): DroneaidDB {
    return droneaidDb(dbOrTx(this.db as unknown as KyselyDB, trx));
  }

  async listByWorkspace(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<DroneaidSignupRule[]> {
    return this.q(trx)
      .selectFrom('droneaidSignupRules')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  async insert(
    workspaceId: string,
    values: SignupRuleValues,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await this.q(trx)
      .insertInto('droneaidSignupRules')
      .values({
        workspaceId,
        pattern: values.pattern,
        spaceIds: sql<string[]>`${values.spaceIds}::uuid[]`,
        spaceRole: values.spaceRole,
      })
      .execute();
  }

  async update(
    workspaceId: string,
    id: string,
    values: SignupRuleValues,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await this.q(trx)
      .updateTable('droneaidSignupRules')
      .set({
        pattern: values.pattern,
        spaceIds: sql<string[]>`${values.spaceIds}::uuid[]`,
        spaceRole: values.spaceRole,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async deleteByIds(
    workspaceId: string,
    ids: string[],
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.q(trx)
      .deleteFrom('droneaidSignupRules')
      .where('workspaceId', '=', workspaceId)
      .where('id', 'in', ids)
      .execute();
  }
}
