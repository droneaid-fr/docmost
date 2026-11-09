import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';

const PROVIDER_TYPE = 'google';
const PROVIDER_NAME = 'Google';

/**
 * "Allow new accounts via Google for matching addresses", stored as
 * `auth_providers(type='google').allow_signup` (one row per workspace, created on
 * first use). `is_enabled` stays false so the row never shows up in the public
 * workspace data that core and the licence-gated client SSO code read.
 */
@Injectable()
export class GoogleSignupSetting {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getOrCreateProvider(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<{ id: string; allowSignup: boolean }> {
    const db = dbOrTx(this.db, trx);
    const existing = await db
      .selectFrom('authProviders')
      .select(['id', 'allowSignup'])
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', PROVIDER_TYPE)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();
    if (existing) return existing;

    return db
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

  async isSignupAllowed(workspaceId: string): Promise<boolean> {
    return (await this.getOrCreateProvider(workspaceId)).allowSignup;
  }

  async setSignupAllowed(
    workspaceId: string,
    allow: boolean,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const provider = await this.getOrCreateProvider(workspaceId, trx);
    await dbOrTx(this.db, trx)
      .updateTable('authProviders')
      .set({ allowSignup: allow, updatedAt: new Date() })
      .where('id', '=', provider.id)
      .execute();
  }
}
