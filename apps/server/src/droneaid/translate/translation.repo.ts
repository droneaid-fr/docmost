import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { DroneaidDB, droneaidDb, DroneaidPageTranslation } from '../db.types';

export type TranslationStatus = 'pending' | 'running' | 'ready' | 'failed';

/** A row left `running` this long belongs to a worker that died. */
export const STALE_RUN_MS = 10 * 60 * 1000;

/**
 * True while the page has not been saved since the version the snapshot was
 * made from. `source_updated_at` comes from a JS Date (milliseconds), hence
 * the 1 ms of slack against the microseconds Postgres keeps.
 */
const CURRENT_BY_TIME = sql<boolean>`(t.source_updated_at is not null and p.updated_at < t.source_updated_at + interval '1 millisecond')`;

/** A finished snapshot and whether it is known to match the page. */
export type ServedCandidate = {
  lang: string;
  sourceLang: string;
  title: string | null;
  sourceHash: string | null;
  /** Unchanged since translated (by timestamp); else compare hashes. */
  current: boolean;
  content?: unknown;
};

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
  'sourceUpdatedAt',
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
   * Stores a finished snapshot made from the page version saved at
   * `sourceUpdatedAt`. The row stays `pending` when it was queued again
   * while this run was in progress, so that request is not lost.
   */
  async complete(
    id: string,
    result: {
      title: string;
      content: any;
      sourceHash: string;
      sourceUpdatedAt: Date;
    },
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
        sourceUpdatedAt: result.sourceUpdatedAt,
        translatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * The page was saved but its text did not change (a move, an icon): the
   * snapshot stays and is marked as made from the version now saved.
   */
  async confirm(id: string, sourceUpdatedAt: Date): Promise<void> {
    await this.db
      .updateTable('droneaidPageTranslations')
      .set({
        status: sql`case when status = 'running' then 'ready' else status end`,
        error: null,
        attempts: 0,
        sourceUpdatedAt,
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

  /**
   * Finished snapshots of a page (one language, or all), with whether the
   * page is unchanged since. Callers serve only snapshots that match the page
   * (ServedTranslations); `content` is loaded only for one language.
   */
  async servedCandidates(
    pageId: string,
    lang?: string,
  ): Promise<ServedCandidate[]> {
    let query = this.db
      .selectFrom('droneaidPageTranslations as t')
      .innerJoin('pages as p', 'p.id', 't.pageId')
      .select([
        't.lang',
        't.sourceLang',
        't.title',
        't.sourceHash',
        CURRENT_BY_TIME.as('current'),
      ])
      .where('t.pageId', '=', pageId)
      .where('t.content', 'is not', null)
      .orderBy('t.lang', 'asc');
    if (lang) {
      query = query.where('t.lang', '=', lang).select('t.content');
    }
    return (await query.execute()) as ServedCandidate[];
  }

  /**
   * Snapshots made from text equal to the page's current text (`hash`) are
   * marked current again, so later reads need no hash.
   */
  async markCurrent(pageId: string, hash: string): Promise<void> {
    await sql`
      update droneaid_page_translations t
         set source_updated_at = p.updated_at
        from pages p
       where p.id = t.page_id
         and t.page_id = ${pageId}
         and t.source_hash = ${hash}
    `.execute(this.db);
  }

  /**
   * Queues finished translations of pages saved since they were made and
   * left alone for `quietMinutes`. Their snapshots are not served meanwhile.
   * The worker skips the model call when the text did not actually change.
   */
  async requeueStale(quietMinutes: number): Promise<number> {
    const result = await sql`
      update droneaid_page_translations t
         set status = 'pending', attempts = 0, error = null,
             available_at = now(), updated_at = now()
        from pages p
       where p.id = t.page_id
         and t.status = 'ready'
         and not ${CURRENT_BY_TIME}
         and p.updated_at <= now() - make_interval(secs => ${quietMinutes * 60})
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
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
