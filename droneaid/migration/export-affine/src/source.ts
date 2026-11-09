/**
 * Reads the restored AFFiNE Postgres. Read-only: every statement is a SELECT.
 * Columns are listed explicitly so secrets (users.password, sessions, token
 * hashes, app_configs secret values) never enter the exporter's memory as
 * named fields that could be written by mistake.
 */
type Prisma = { $queryRawUnsafe<T = unknown>(sql: string, ...args: unknown[]): Promise<T> };

export type SourceData = Awaited<ReturnType<typeof readSource>>;

export async function readSource(db: Prisma) {
  const q = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);

  const [
    workspaces,
    members,
    accessPolicies,
    invitations,
    users,
    userFeatures,
    pages,
    docSnapshots,
    systemSnapshots,
    blobs,
    docGrants,
    docPolicies,
    translations,
    comments,
    replies,
    appConfigs,
    historyCounts,
    counts,
  ] = await Promise.all([
    q<{ id: string; name: string | null; created_at: Date; avatar_key: string | null; enable_ai: boolean; enable_doc_embedding: boolean }>(
      `select id, name, created_at, avatar_key, enable_ai, enable_doc_embedding from workspaces order by id`
    ),
    q<{ workspace_id: string; user_id: string; role: string; state: string; source: string; created_at: Date }>(
      `select workspace_id, user_id, role, state, source, created_at from workspace_members order by workspace_id, user_id`
    ),
    q<{ workspace_id: string; visibility: string; sharing_enabled: boolean; url_preview_enabled: boolean; member_default_doc_role: string }>(
      `select workspace_id, visibility, sharing_enabled, url_preview_enabled, member_default_doc_role from workspace_access_policies order by workspace_id`
    ),
    q<{ workspace_id: string; normalized_email: string | null; requested_role: string; status: string; kind: string; created_at: Date; expires_at: Date | null }>(
      `select workspace_id, normalized_email, requested_role, status, kind, created_at, expires_at from workspace_invitations order by workspace_id, created_at, id`
    ),
    q<{ id: string; name: string; email: string; created_at: Date; email_verified: Date | null; avatar_url: string | null; registered: boolean; disabled: boolean; agent_of_workspace_id: string | null; has_password: boolean }>(
      `select id, name, email, created_at, email_verified, avatar_url, registered, disabled, agent_of_workspace_id, (password is not null) as has_password from users order by email, id`
    ),
    q<{ user_id: string; name: string; type: number; activated: boolean; reason: string; created_at: Date; expired_at: Date | null }>(
      `select user_id, name, type, activated, reason, created_at, expired_at from user_features order by user_id, name, id`
    ),
    q<{ workspace_id: string; page_id: string; mode: number; title: string | null; published_at: Date | null; blocked: boolean }>(
      `select workspace_id, page_id, mode, title, published_at, blocked from workspace_pages order by workspace_id, page_id`
    ),
    q<{ workspace_id: string; guid: string; blob: Uint8Array; created_at: Date; updated_at: Date; created_by: string | null; updated_by: string | null }>(
      `select workspace_id, guid, blob, created_at, updated_at, created_by, updated_by from snapshots
       where guid <> workspace_id and guid not like 'db$%' and guid not like 'userdata$%' order by workspace_id, guid`
    ),
    q<{ workspace_id: string; guid: string; blob: Uint8Array }>(
      `select workspace_id, guid, blob from snapshots
       where guid = workspace_id or guid like 'db$%' or guid like 'userdata$%' order by workspace_id, guid`
    ),
    q<{ workspace_id: string; key: string; size: number; mime: string; created_at: Date; status: string; deleted_at: Date | null }>(
      `select workspace_id, key, size, mime, created_at, status::text as status, deleted_at from blobs order by workspace_id, key`
    ),
    q<{ workspace_id: string; doc_id: string; principal_type: string; principal_id: string; role: string; granted_by: string | null; created_at: Date }>(
      `select workspace_id, doc_id, principal_type, principal_id, role, granted_by, created_at from doc_grants order by workspace_id, doc_id, principal_type, principal_id`
    ),
    q<{ workspace_id: string; doc_id: string; visibility: string; public_role: string | null; member_default_role: string | null; url_preview_enabled: boolean; published_at: Date | null }>(
      `select workspace_id, doc_id, visibility, public_role, member_default_role, url_preview_enabled, published_at from doc_access_policies order by workspace_id, doc_id`
    ),
    q<{ workspace_id: string; doc_id: string; lang: string; source_lang: string; status: string; title: string | null; bin: Uint8Array | null; error: string | null; source_timestamp: Date | null; updated_at: Date }>(
      `select workspace_id, doc_id, lang, source_lang, status, title, bin, error, source_timestamp, updated_at from doc_translations order by workspace_id, doc_id, lang`
    ),
    q<{ id: string; workspace_id: string; doc_id: string; user_id: string; content: unknown; created_at: Date; updated_at: Date; deleted_at: Date | null; resolved: boolean }>(
      `select id, workspace_id, doc_id, user_id, content, created_at, updated_at, deleted_at, resolved from comments order by workspace_id, doc_id, created_at, id`
    ),
    q<{ id: string; comment_id: string; workspace_id: string; doc_id: string; user_id: string; content: unknown; created_at: Date; updated_at: Date; deleted_at: Date | null }>(
      `select id, comment_id, workspace_id, doc_id, user_id, content, created_at, updated_at, deleted_at from replies order by comment_id, created_at, id`
    ),
    // Values are read, but only allow-listed ones are ever written (pure.ts).
    q<{ id: string; value: unknown }>(`select id, value from app_configs order by id`),
    q<{ workspace_id: string; guid: string; n: bigint }>(
      `select workspace_id, guid, count(*) as n from snapshot_histories group by 1, 2 order by 1, 2`
    ),
    q<{ name: string; n: bigint }>(
      `select 'users' as name, count(*) as n from users
       union all select 'workspaces', count(*) from workspaces
       union all select 'workspace_members', count(*) from workspace_members
       union all select 'workspace_pages', count(*) from workspace_pages
       union all select 'snapshots', count(*) from snapshots
       union all select 'snapshots_docs', count(*) from snapshots where guid <> workspace_id and guid not like 'db$%' and guid not like 'userdata$%'
       union all select 'snapshot_histories', count(*) from snapshot_histories
       union all select 'updates', count(*) from updates
       union all select 'blobs', count(*) from blobs
       union all select 'doc_grants', count(*) from doc_grants
       union all select 'doc_translations', count(*) from doc_translations
       union all select 'published_docs', count(*) from doc_access_policies where visibility = 'public'
       union all select 'comments', count(*) from comments
       union all select 'replies', count(*) from replies
       union all select 'app_configs', count(*) from app_configs`
    ),
  ]);

  const dbCounts = Object.fromEntries(counts.map(c => [c.name, Number(c.n)]));
  if (dbCounts.updates !== 0) {
    // Pending updates are not merged into snapshots here; refuse rather than
    // export stale content.
    throw new Error(`${dbCounts.updates} unmerged rows in "updates"; merge them first`);
  }

  return {
    workspaces,
    members,
    accessPolicies,
    invitations,
    users,
    userFeatures,
    pages,
    docSnapshots,
    systemSnapshots,
    blobs,
    docGrants,
    docPolicies,
    translations,
    comments,
    replies,
    appConfigs,
    historyCounts,
    dbCounts,
  };
}
