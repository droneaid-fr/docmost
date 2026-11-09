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

  /** A running row is still being worked on (see STALE_RUN_MS). */
  async heartbeat(id: string): Promise<void> {
    await this.db
      .updateTable('droneaidPageTranslations')
      .set({ updatedAt: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .execute();
  }

  /**
   * Deletes the translations of pages that are trashed, gone or no longer
   * reachable through a share, in one statement. "Reachable" is core's rule
   * (ShareService.getShareForPage): the page's own share, or the nearest
   * shared ancestor when that share includes sub-pages, at most 25 levels up,
   * in the page's workspace.
   */
  async deleteUnshared(): Promise<number> {
    const result = await sql`
      with recursive chain as (
        select p.id as origin, p.workspace_id as page_ws, p.parent_page_id,
               0 as level, s.id as share_id, s.include_sub_pages,
               s.workspace_id as share_ws
          from (select distinct page_id from droneaid_page_translations) tp
          join pages p on p.id = tp.page_id and p.deleted_at is null
          left join shares s on s.page_id = p.id
        union all
        select c.origin, c.page_ws, p.parent_page_id, c.level + 1, s.id,
               s.include_sub_pages, s.workspace_id
          from chain c
          join pages p on p.id = c.parent_page_id and p.deleted_at is null
          left join shares s on s.page_id = p.id
         where c.share_id is null and c.level < 25
      ),
      nearest as (
        select distinct on (origin) origin, level, include_sub_pages,
               share_ws, page_ws
          from chain
         where share_id is not null
         order by origin, level
      )
      delete from droneaid_page_translations t
       where not exists (
         select 1 from nearest n
          where n.origin = t.page_id
            and n.share_ws = n.page_ws
            and (n.level = 0 or n.include_sub_pages)
       )
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  async deleteForPage(pageId: string): Promise<void> {
    await this.db
      .deleteFrom('droneaidPageTranslations')
      .where('pageId', '=', pageId)
      .execute();
  }
}
