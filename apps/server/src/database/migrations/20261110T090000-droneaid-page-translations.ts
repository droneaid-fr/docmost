import { type Kysely, sql } from 'kysely';

// DroneAid: machine translations of published pages
// (apps/server/src/droneaid/translate). One row per page and target language;
// `content` is the served ProseMirror snapshot. Translations are not pages, so
// they never reach the page tree or search.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('droneaid_page_translations')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('lang', 'varchar', (col) => col.notNull())
    .addColumn('source_lang', 'varchar', (col) => col.notNull())
    // pending | running | ready | failed
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('pending'))
    .addColumn('title', 'text')
    .addColumn('content', 'jsonb')
    // Hash of the source (title + content) the served snapshot was made from.
    .addColumn('source_hash', 'varchar')
    .addColumn('error', 'text')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('available_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('translated_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('droneaid_page_translations_page_lang_unique', [
      'page_id',
      'lang',
    ])
    .execute();

  await db.schema
    .createIndex('droneaid_page_translations_due_idx')
    .on('droneaid_page_translations')
    .columns(['status', 'available_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('droneaid_page_translations').execute();
}
