import { type Kysely, sql } from 'kysely';

// DroneAid: AFFiNE -> Docmost import map (apps/server/src/droneaid/migration).
// One row per imported source object, so a re-run skips what exists and a
// different bundle is refused.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('droneaid_import_map')
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    // bundle | user | space | page | attachment | share | translation |
    // comment | agent | signup-rules | backlinks
    .addColumn('kind', 'varchar', (col) => col.notNull())
    .addColumn('source_id', 'varchar', (col) => col.notNull())
    .addColumn('target_id', 'varchar', (col) => col.notNull())
    .addColumn('bundle_sha256', 'varchar', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('droneaid_import_map_pkey', [
      'workspace_id',
      'kind',
      'source_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('droneaid_import_map').execute();
}
