import { type Kysely, sql } from 'kysely';

// DroneAid: signup allowlist rules and their space grants
// (apps/server/src/droneaid/signup-rules).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('droneaid_signup_rules')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    // Domain (`example.com`), wildcard (`*.example.com`) or address, stored lower-case.
    .addColumn('pattern', 'varchar', (col) => col.notNull())
    // No foreign key: a deleted space stays listed on the rule and is skipped at grant time.
    .addColumn('space_ids', sql`uuid[]`, (col) =>
      col.notNull().defaultTo(sql`'{}'::uuid[]`),
    )
    .addColumn('space_role', 'varchar', (col) =>
      col.notNull().defaultTo('writer'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('droneaid_signup_rules_workspace_id_idx')
    .on('droneaid_signup_rules')
    .column('workspace_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('droneaid_signup_rules').execute();
}
