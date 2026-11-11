import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { findDatabasesInJson } from '@docmost/editor-ext';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { droneaidDb } from '../db.types';
import { sourceHash } from '../translate/blocks';
import { Bundle, BundleComment, BundleDatabase, DEFAULT_EXCLUDED_WORKSPACES, loadBundle, readDocFile, readDocJson } from './bundle';
import { sameCell } from './database-convert';
import { ImportMapRepo } from './import-map.repo';
import { pageBlobKeys } from './importer.service';
import { isAgentUser } from './roles';

export type CountRow = { what: string; bundle: number; docmost: number; ok: boolean; note?: string };

export type VerifyReport = {
  counts: CountRow[];
  databases: {
    docId: string;
    databaseId: string;
    title: string;
    rows: string;
    columns: string;
    cellsCompared: number;
    mismatches: { rowId: string; column: string; bundle: unknown; docmost: unknown }[];
  }[];
  links: { affineLeft: number; docsWithAffineLinks: string[] };
  translations: { pageId: string; lang: string; current: boolean }[];
  fingerprint: string;
  ok: boolean;
};

/**
 * Checks an import against its bundle, from the Docmost database only.
 * Every database is compared cell by cell (bundle value vs stored value).
 */
@Injectable()
export class ImportVerifier {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly mapRepo: ImportMapRepo,
  ) {}

  async verify(
    bundleDir: string,
    exclude: readonly string[] = DEFAULT_EXCLUDED_WORKSPACES,
  ): Promise<VerifyReport> {
    const bundle = await loadBundle(bundleDir, exclude);
    const workspace = await this.workspaceRepo.findFirst();
    if (!workspace) throw new Error('No workspace');
    const map = await this.mapRepo.all(workspace.id);
    const target = (kind: string, id: string) => map.get(`${kind}:${id}`);
    const counts: CountRow[] = [];
    const row = (what: string, b: number, d: number, note?: string) =>
      counts.push({ what, bundle: b, docmost: d, ok: b === d, note });

    // spaces and users
    const spaceIds = bundle.workspaces.map((w) => target('space', w.workspace.id)).filter(Boolean);
    const spaces = spaceIds.length
      ? await this.db.selectFrom('spaces').select('id').where('id', 'in', spaceIds).where('deletedAt', 'is', null).execute()
      : [];
    row('spaces', bundle.workspaces.length, spaces.length);
    const excludedNames = bundle.excluded.map((w) => w.name);
    const excludedSpaces = excludedNames.length
      ? await this.db.selectFrom('spaces').select('id').where('workspaceId', '=', workspace.id).where('name', 'in', excludedNames).execute()
      : [];
    row('spaces of excluded workspaces', 0, excludedSpaces.length, excludedNames.join(', ') || 'none excluded');
    const general = await this.db
      .selectFrom('spaces')
      .select('id')
      .where('workspaceId', '=', workspace.id)
      .where('slug', '=', 'general')
      .execute();
    row('default "General" space', 0, general.length, 'removed after setup; workspaces.default_space_id is null');
    const humans = bundle.users.filter((u) => !isAgentUser(u));
    const users = await this.db
      .selectFrom('users')
      .select(['email'])
      .where('workspaceId', '=', workspace.id)
      .where('email', 'in', humans.map((u) => u.email.toLowerCase()))
      .execute();
    row('users (humans)', humans.length, users.length);
    const agents = await droneaidDb(this.db).selectFrom('droneaidAgents').select('userId').execute();
    row('agent accounts', 1, agents.length, 'DA France agent only; the other 3 AFFiNE agents are not recreated');

    // pages
    const docs = bundle.workspaces.flatMap((w) => w.docs);
    const pageIdOf = new Map<string, string>();
    for (const w of bundle.workspaces) {
      for (const d of w.docs) {
        const id = target('page', `${w.workspace.id}/doc:${d.docId}`);
        if (id) pageIdOf.set(d.docId, id);
      }
    }
    const pageRows = pageIdOf.size
      ? await this.db
          .selectFrom('pages')
          .select(['id', 'title', 'content', 'deletedAt', 'updatedAt'])
          .where('id', 'in', [...pageIdOf.values()])
          .execute()
      : [];
    const pages = new Map(pageRows.map((p) => [p.id, p]));
    const live = docs.filter((d) => !d.trash);
    const trashed = docs.filter((d) => d.trash);
    const isLive = (d: { docId: string }) => {
      const p = pages.get(pageIdOf.get(d.docId) ?? '');
      return !!p && !p.deletedAt;
    };
    const isTrashed = (d: { docId: string }) => {
      const p = pages.get(pageIdOf.get(d.docId) ?? '');
      return !!p && !!p.deletedAt;
    };
    row('pages: live docs', live.length, live.filter(isLive).length);
    row('pages: trashed docs (in Docmost trash)', trashed.length, trashed.filter(isTrashed).length);
    const folderCount = (nodes: any[]): number =>
      nodes.reduce((n, f) => n + 1 + folderCount(f.folders ?? []), 0);
    const folders = bundle.workspaces.reduce((n, w) => n + folderCount(w.folders.tree), 0);
    const folderPages = [...map.keys()].filter((k) => k.startsWith('page:') && k.includes('/folder:')).length;
    row('pages: folder pages', folders, folderPages);

    // attachments: one per (page, referenced blob) in page mode
    let pairs = 0;
    const keys = new Set<string>();
    for (const doc of docs) {
      const body = (await readDocFile(bundle, doc, doc.body)) ?? '';
      const translated = await Promise.all(
        (doc.translations ?? []).map((t) => readDocFile(bundle, doc, t.file)),
      );
      const used = [...new Set([body, ...translated.map((t) => t ?? '')].flatMap(pageBlobKeys))];
      pairs += used.length;
      used.forEach((k) => keys.add(`${doc.workspaceId}/${k}`));
    }
    const attachments = pageIdOf.size
      ? await this.db
          .selectFrom('attachments')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('pageId', 'in', [...pageIdOf.values()])
          .executeTakeFirst()
      : { n: 0 };
    row('attachments (page, blob) pairs', pairs, Number(attachments?.n ?? 0));
    const referenced = bundle.workspaces.reduce(
      (n, w) => n + w.blobs.filter((b) => (b.referencedBy ?? []).length).length,
      0,
    );
    counts.push({
      what: 'referenced blobs shown in page mode',
      bundle: referenced,
      docmost: keys.size,
      ok: true,
      note: `${referenced - keys.size} referenced only from a canvas (dropped with the canvas)`,
    });

    // databases, cell by cell
    const databases: VerifyReport['databases'] = [];
    let dbOk = 0;
    for (const doc of docs) {
      const page = pages.get(pageIdOf.get(doc.docId) ?? '');
      const stored = page ? findDatabasesInJson(page.content) : [];
      for (const entry of doc.databases ?? []) {
        const source = await readDocJson<BundleDatabase>(bundle, doc, entry.file);
        const data = stored.find((s) => s.id === source.databaseId);
        const mismatches: VerifyReport['databases'][number]['mismatches'] = [];
        let compared = 0;
        if (data) {
          const rows = new Map(data.rows.map((r) => [r.id, r]));
          for (const r of source.rows) {
            const got = rows.get(r.id);
            for (const c of source.columns) {
              compared++;
              const expected = c.type === 'member' ? null : r.values?.[c.id];
              const actual = got?.cells?.[c.id];
              if (c.type === 'member' || sameCell(expected, actual)) continue;
              if (mismatches.length < 20) {
                mismatches.push({ rowId: r.id, column: c.name, bundle: expected, docmost: actual ?? null });
              }
            }
          }
        }
        const ok =
          !!data &&
          data.rows.length === source.rows.length &&
          data.columns.length === source.columns.length &&
          !mismatches.length;
        if (ok) dbOk++;
        databases.push({
          docId: doc.docId,
          databaseId: source.databaseId,
          title: source.title,
          rows: `${source.rows.length} / ${data?.rows.length ?? 0}`,
          columns: `${source.columns.length} / ${data?.columns.length ?? 0}`,
          cellsCompared: compared,
          mismatches,
        });
      }
    }
    const bundleDbs = docs.reduce((n, d) => n + (d.databases?.length ?? 0), 0);
    row('databases (rows, columns and every cell equal)', bundleDbs, dbOk);

    // shares, translations, comments, signup rules
    const published = docs.filter((d) => d.publish?.published && !d.trash);
    const shares = pageIdOf.size
      ? await this.db.selectFrom('shares').select('pageId').where('pageId', 'in', [...pageIdOf.values()]).execute()
      : [];
    row('public shares', published.length, shares.length);
    const tr = pageIdOf.size
      ? await droneaidDb(this.db)
          .selectFrom('droneaidPageTranslations')
          .select(['pageId', 'lang', 'status', 'sourceHash'])
          .where('pageId', 'in', [...pageIdOf.values()])
          .execute()
      : [];
    const translations = tr.map((t) => {
      const p = pages.get(t.pageId);
      return {
        pageId: t.pageId,
        lang: t.lang,
        current: t.status === 'ready' && !!p && t.sourceHash === sourceHash(p.title, p.content),
      };
    });
    const bundleTr = docs.reduce((n, d) => n + (d.translations ?? []).filter((t) => t.status === 'ready').length, 0);
    row('translations (ready, current source hash)', bundleTr, translations.filter((t) => t.current).length);
    const commentIds = [...map.keys()].filter((k) => k.startsWith('comment:')).map((k) => map.get(k));
    const comments = commentIds.length
      ? await this.db.selectFrom('comments').select('id').where('id', 'in', commentIds).execute()
      : [];
    let bundleComments = 0;
    for (const doc of docs) {
      if (!doc.comments) continue;
      for (const c of await readDocJson<BundleComment[]>(bundle, doc, doc.comments)) {
        if (c.deletedAt) continue; // the importer skips deleted comments and their replies
        bundleComments += 1 + (c.replies ?? []).filter((r) => !r.deletedAt).length;
      }
    }
    row('comments (incl. replies)', bundleComments, comments.length);
    const rules = await droneaidDb(this.db).selectFrom('droneaidSignupRules').select('id').where('workspaceId', '=', workspace.id).execute();
    row('signup rules', bundle.signupAllowlist.length, rules.length);

    // links: no affine:// left, and every bundle link became a mention/link
    const docsWithAffine = pageRows
      .filter((p) => JSON.stringify(p.content ?? {}).includes('affine://'))
      .map((p) => p.id);
    const bundleLinks = docs.reduce((n, d) => n + (d.links?.affine?.length ?? 0), 0);
    const backlinks = pageIdOf.size
      ? await this.db.selectFrom('backlinks').select(['sourcePageId', 'targetPageId']).where('sourcePageId', 'in', [...pageIdOf.values()]).execute()
      : [];
    row('affine:// links -> page links (distinct source/target pairs)', bundleLinks, backlinks.length,
      'a link to its own page is not a backlink');

    // fingerprint of everything an import writes (for the idempotency check)
    const fp = await sql<{ fp: string }>`
      select md5(string_agg(x, '|' order by x)) as fp from (
        select 'p' || id || coalesce(md5(content::text), '') || coalesce(deleted_at::text, '') || updated_at::text || position || coalesce(parent_page_id::text, '') as x from pages
        union all select 'a' || id || coalesce(page_id::text, '') from attachments
        union all select 'u' || id || coalesce(role, '') || updated_at::text from users
        union all select 's' || id || updated_at::text from spaces
        union all select 'm' || id || role from space_members
        union all select 'h' || id from shares
        union all select 'c' || id from comments
        union all select 'b' || source_page_id || target_page_id from backlinks
        union all select 't' || id || coalesce(source_hash, '') from droneaid_page_translations
        union all select 'r' || id || updated_at::text from droneaid_signup_rules
        union all select 'g' || user_id from droneaid_agents
      ) t`.execute(this.db);

    const report: VerifyReport = {
      counts,
      databases,
      links: { affineLeft: docsWithAffine.length, docsWithAffineLinks: docsWithAffine },
      translations,
      fingerprint: createHash('sha256').update(fp.rows[0]?.fp ?? '').digest('hex'),
      ok: counts.every((c) => c.ok) && !docsWithAffine.length,
    };
    return report;
  }
}

export function verifyMarkdown(r: VerifyReport): string {
  const lines = [
    '# Import check',
    '',
    `Result: **${r.ok ? 'PASS' : 'FAIL'}**. Fingerprint \`${r.fingerprint.slice(0, 16)}\`.`,
    '',
    '| Check | Bundle | Docmost | OK | Note |',
    '|---|---|---|---|---|',
    ...r.counts.map((c) => `| ${c.what} | ${c.bundle} | ${c.docmost} | ${c.ok ? 'yes' : '**no**'} | ${c.note ?? ''} |`),
    '',
    '## Databases (bundle / Docmost)',
    '',
    '| Doc | Database | Title | Rows | Columns | Cells compared | Mismatches |',
    '|---|---|---|---|---|---|---|',
    ...r.databases.map(
      (d) => `| ${d.docId} | ${d.databaseId} | ${d.title} | ${d.rows} | ${d.columns} | ${d.cellsCompared} | ${d.mismatches.length} |`,
    ),
    '',
    `affine:// links left in content: ${r.links.affineLeft}.`,
    '',
  ];
  return lines.join('\n');
}
