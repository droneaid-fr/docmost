import { type Kysely, sql } from 'kysely';

// DroneAid: personal MCP tokens of human members (apps/server/src/droneaid/personal-tokens).
// Kept apart from droneaid_agent_tokens so a token's kind (agent or person)
// is never ambiguous: each table is read only for its own prefix.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('droneaid_user_mcp_tokens')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('token_hash', 'varchar', (col) => col.notNull().unique())
    .addColumn('token_prefix', 'varchar', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('expires_at', 'timestamptz')
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('droneaid_user_mcp_tokens_user_id_idx')
    .on('droneaid_user_mcp_tokens')
    .columns(['user_id', 'workspace_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('droneaid_user_mcp_tokens').execute();
}
