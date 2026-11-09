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

// Fires the BEFORE UPDATE trigger on every row, which recomputes tsv.
const rebuildPagesTsv = sql`UPDATE pages SET title = title`;

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
