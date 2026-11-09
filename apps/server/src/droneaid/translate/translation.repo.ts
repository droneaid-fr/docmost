import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { DroneaidDB, droneaidDb, DroneaidPageTranslation } from '../db.types';

export type TranslationStatus = 'pending' | 'running' | 'ready' | 'failed';

/** A row left `running` this long belongs to a worker that died. */
export const STALE_RUN_MS = 10 * 60 * 1000;

/** Every column except the snapshot, which only the public route needs. */
export type TranslationSummary = Omit<DroneaidPageTranslation, 'content'>;

const SUMMARY = [
  'id',
  'workspaceId',
  'pageId',
  'lang',
  'sourceLang',
  'status',
  'title',
  'sourceHash',
  'error',
  'attempts',
  'availableAt',
  'translatedAt',
  'createdAt',
  'updatedAt',
] as const;

@Injectable()
export class TranslationRepo {
  private readonly db: DroneaidDB;

  constructor(@InjectKysely() db: KyselyDB) {
    this.db = droneaidDb(db);
  }

  list(pageId: string): Promise<TranslationSummary[]> {
    return this.db
      .selectFrom('droneaidPageTranslations')
      .select(SUMMARY)
      .where('pageId', '=', pageId)
      .orderBy('lang', 'asc')
      .execute();
  }

  /**
   * Makes the page's translation set exactly `langs`. New languages, and every
   * language when the source language changed, are queued; finished rows of
   * an unchanged source language are kept as they are.
   */
  async setLanguages(
    workspaceId: string,
    pageId: string,
    sourceLang: string,
    langs: string[],
  ): Promise<void> {
    await executeTx(this.db as unknown as KyselyDB, async (trx) => {
      const tx = droneaidDb(trx);
      let remove = tx
        .deleteFrom('droneaidPageTranslations')
        .where('pageId', '=', pageId);
      if (langs.length) remove = remove.where('lang', 'not in', langs);
      await remove.execute();
      await tx
        .updateTable('droneaidPageTranslations')
        .set({
          sourceLang,
          status: 'pending',
          attempts: 0,
          error: null,
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('pageId', '=', pageId)
        .where('sourceLang', '!=', sourceLang)
        .execute();
      if (langs.length) {
        await tx
          .insertInto('droneaidPageTranslations')
          .values(
            langs.map((lang) => ({ workspaceId, pageId, lang, sourceLang })),
          )
          .onConflict((oc) => oc.columns(['pageId', 'lang']).doNothing())
          .execute();
      }
    });
  }

  /** Queues every language of the page again; served snapshots stay. */
  async requeue(pageId: string): Promise<number> {
    const result = await this.db
      .updateTable('droneaidPageTranslations')
      .set({
        status: 'pending',
        attempts: 0,
        error: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where('pageId', '=', pageId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  /**
   * Takes the next due row. `for update skip locked` makes the claim safe
   * when several server instances run the job at once.
   */
  async claimNext(): Promise<TranslationSummary | null> {
    const staleBefore = new Date(Date.now() - STALE_RUN_MS);
    const row = await this.db
      .updateTable('droneaidPageTranslations')
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        'id',
        '=',
        (eb) =>
          eb
            .selectFrom('droneaidPageTranslations')
            .select('id')
            .where((w) =>
              w.or([
                w.and([
                  w('status', '=', 'pending'),
                  w('availableAt', '<=', new Date()),
                ]),
                w.and([
                  w('status', '=', 'running'),
                  w('updatedAt', '<', staleBefore),
                ]),
              ]),
            )
            .orderBy('availableAt', 'asc')
            .limit(1)
            .forUpdate()
            .skipLocked() as any,
      )
      .returning(SUMMARY)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Stores a finished snapshot. The row stays `pending` when it was queued
   * again while this run was in progress, so that request is not lost.
   */
  async complete(
    id: string,
    result: { title: string; content: any; sourceHash: string },
  ): Promise<void> {
    await this.db
      .updateTable('droneaidPageTranslations')
      .set({
        status: sql`case when status = 'running' then 'ready' else status end`,
        error: null,
        attempts: 0,
        title: result.title,
        content: result.content,
        sourceHash: result.sourceHash,
        translatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .updateTable('droneaidPageTranslations')
      .set({
        status: 'failed',
        error: error.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  /** Puts a row back in the queue, not before `until`. */
  async postpone(id: string, until: Date): Promise<void> {
    await this.db
      .updateTable('droneaidPageTranslations')
      .set((eb) => ({
        status: 'pending',
        availableAt: until,
        attempts: eb('attempts', '+', 1),
        updatedAt: new Date(),
      }))
      .where('id', '=', id)
      .execute();
  }

  /** The last finished translation, even while a newer one is in progress. */
  async getServed(
    pageId: string,
    lang: string,
  ): Promise<{ title: string | null; content: any } | null> {
    const row = await this.db
      .selectFrom('droneaidPageTranslations')
      .select(['title', 'content'])
      .where('pageId', '=', pageId)
      .where('lang', '=', lang)
      .where('content', 'is not', null)
      .executeTakeFirst();
    return row ? { title: row.title, content: row.content } : null;
  }

  /** Languages a reader can switch to right now. */
  servedLanguages(
    pageId: string,
  ): Promise<{ lang: string; sourceLang: string }[]> {
    return this.db
      .selectFrom('droneaidPageTranslations')
      .select(['lang', 'sourceLang'])
      .where('pageId', '=', pageId)
      .where('content', 'is not', null)
      .orderBy('lang', 'asc')
      .execute();
  }

  async pageIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('droneaidPageTranslations')
      .select('pageId')
      .distinct()
      .execute();
    return rows.map((row) => row.pageId);
  }

  async deleteForPage(pageId: string): Promise<void> {
    await this.db
      .deleteFrom('droneaidPageTranslations')
      .where('pageId', '=', pageId)
      .execute();
  }
}
