import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { DroneaidDB, droneaidDb } from '../db.types';

export type ImportKind =
  | 'bundle'
  | 'user'
  | 'space'
  | 'page'
  | 'attachment'
  | 'share'
  | 'translation'
  | 'comment'
  | 'agent'
  | 'signup-rules';

/** `droneaid_import_map`: source object -> created Docmost object. */
@Injectable()
export class ImportMapRepo {
  private readonly db: DroneaidDB;

  constructor(@InjectKysely() db: KyselyDB) {
    this.db = droneaidDb(db);
  }

  private q(trx?: KyselyTransaction): DroneaidDB {
    return droneaidDb(dbOrTx(this.db as unknown as KyselyDB, trx));
  }

  async all(workspaceId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('droneaidImportMap')
      .select(['kind', 'sourceId', 'targetId'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    return new Map(rows.map((r) => [`${r.kind}:${r.sourceId}`, r.targetId]));
  }

  async bundles(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('droneaidImportMap')
      .select('sourceId')
      .where('workspaceId', '=', workspaceId)
      .where('kind', '=', 'bundle')
      .execute();
    return rows.map((r) => r.sourceId);
  }

  async put(
    workspaceId: string,
    bundleSha256: string,
    kind: ImportKind,
    sourceId: string,
    targetId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await this.q(trx)
      .insertInto('droneaidImportMap')
      .values({ workspaceId, kind, sourceId, targetId, bundleSha256 })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'kind', 'sourceId']).doNothing(),
      )
      .execute();
  }
}
