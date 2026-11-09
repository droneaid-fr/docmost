import { type Kysely, sql } from 'kysely';

// droneaid: page full-text search in French. Creates the `droneaid_search`
// text search configuration (a copy of Postgres's built-in `french`), points
// the pages tsvector trigger at it and rebuilds every `pages.tsv`.
// SearchService queries with the same name (droneaid/search/search-config.ts).
// The trigger body is upstream's (20250729T213756) with only the config swapped.

function pagesTrigger(config: string) {
  const cfg = sql.lit(config);
  return sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector(${cfg}, f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector(${cfg}, f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `;
}

// Fires the BEFORE UPDATE trigger, which recomputes tsv, on every page not in
// the trash. Trashed pages are skipped: core search filters
// `deleted_at IS NULL` in every query (SearchService), and restoring a page is
// an UPDATE, so the trigger (BEFORE INSERT OR UPDATE, any column) rebuilds its
// tsv then.
//
// Cost: one statement that rewrites every live page row (a new row version,
// full tsvector recomputation, index updates) in the boot transaction;
// production migrations run on boot. That is fine for our ~100 pages. On a
// large instance (tens of thousands of pages, megabytes of text each) expect
// minutes of boot time, row locks on pages for the duration and table bloat
// until autovacuum; batch it by id range there instead.
//
// Only `pages.tsv` is switched to French. The other full-text columns keep
// upstream's `english` config: `attachments.tsv`, `ai_chat_messages.tsv`
// and `templates.tsv`.
const rebuildPagesTsv = sql`UPDATE pages SET title = title WHERE deleted_at IS NULL`;

export async function up(db: Kysely<any>): Promise<void> {
  await sql`DROP TEXT SEARCH CONFIGURATION IF EXISTS droneaid_search`.execute(db);
  await sql`CREATE TEXT SEARCH CONFIGURATION droneaid_search (COPY = french)`.execute(db);
  await pagesTrigger('droneaid_search').execute(db);
  await rebuildPagesTsv.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await pagesTrigger('english').execute(db);
  await rebuildPagesTsv.execute(db);
  await sql`DROP TEXT SEARCH CONFIGURATION IF EXISTS droneaid_search`.execute(db);
}
