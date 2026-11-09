import { type Kysely } from 'kysely';

// DroneAid: `pages.updated_at` of the page version a translation was made
// from (apps/server/src/droneaid/translate). Lets the server tell in SQL
// whether a translation may still be current, so it neither serves a stale
// snapshot nor loads every page to find the ones to translate again.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('droneaid_page_translations')
    .addColumn('source_updated_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('droneaid_page_translations')
    .dropColumn('source_updated_at')
    .execute();
}
