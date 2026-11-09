/**
 * AFFiNE → bundle exporter (Docmost migration, step S6a).
 *
 *   ./run.sh --source-backup affine-20261108T213045Z [--out DIR]
 *
 * Reads the restored AFFiNE Postgres and blob storage, never writes to them.
 * See README.md for the bundle format.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';

import { BundleWriter } from './bundle.ts';
import { exportWorkspaces } from './export.ts';
import { loadFork } from './fork.ts';
import { OLD_HOSTS, oldUrlInventory, redactAppConfigs, isoOrNull, sha256, stableJson } from './pure.ts';
import { buildChecks, manifestChecks, readBackupManifest, renderReport } from './report.ts';
import { readSource } from './source.ts';

export const EXPORTER_VERSION = '1.0.0';
/** Bump when the bundle layout changes in a way S6b must know about. */
export const BUNDLE_FORMAT = 1;

const { values: args } = parseArgs({
  options: {
    'affine-server': { type: 'string' },
    'database-url': { type: 'string' },
    storage: { type: 'string' },
    out: { type: 'string' },
    'source-backup': { type: 'string' },
    'backup-manifest': { type: 'string' },
  },
});

function required(name: keyof typeof args) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required`);
  return String(value);
}

async function main() {
  const started = Date.now();
  const serverDir = required('affine-server');
  const finalDir = required('out');
  const partial = `${finalDir}.partial`;
  const sourceBackup = required('source-backup');

  const fork = await loadFork(serverDir);
  const db = new fork.PrismaClient({ datasourceUrl: required('database-url') });
  const timings: Record<string, number> = {};
  const lap = (name: string, from: number) => (timings[name] = Date.now() - from);

  try {
    let t = Date.now();
    const src = await readSource(db);
    lap('readSource', t);

    const out = new BundleWriter(partial);
    t = Date.now();
    const stats = exportWorkspaces(fork, src, out, required('storage'));
    lap('workspacesDocsBlobs', t);

    // ---------------------------------------------------------- instance
    const featuresBy = (userId: string) => src.userFeatures.filter(f => f.user_id === userId);
    out.json(
      'instance/users.json',
      src.users.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatar_url,
        registered: u.registered,
        disabled: u.disabled,
        emailVerified: isoOrNull(u.email_verified),
        createdAt: isoOrNull(u.created_at),
        hasPassword: u.has_password,
        agentOfWorkspaceId: u.agent_of_workspace_id,
        admin: featuresBy(u.id).some(f => f.name === 'administrator' && f.activated),
        features: featuresBy(u.id).map(f => ({ name: f.name, activated: f.activated, reason: f.reason, createdAt: isoOrNull(f.created_at), expiredAt: isoOrNull(f.expired_at) })),
        memberships: src.members.filter(m => m.user_id === u.id).map(m => ({ workspaceId: m.workspace_id, role: m.role, state: m.state })),
      }))
    );
    const configs = redactAppConfigs(src.appConfigs);
    out.json('instance/app-config.json', {
      keys: configs,
      signupAllowlist: configs.find(c => c.key === 'auth.allowedEmailDomains')?.value ?? null,
      translation: configs.filter(c => c.key.startsWith('translate.')),
    });
    out.json('instance/published-docs.json', stats.publishedDocs);
    const agents = src.users.filter(u => u.agent_of_workspace_id);
    out.json(
      'instance/agents.json',
      agents.map(a => ({
        userId: a.id,
        email: a.email,
        workspaceId: a.agent_of_workspace_id,
        grants: src.docGrants
          .filter(g => g.principal_type === 'user' && g.principal_id === a.id)
          .map(g => ({ workspaceId: g.workspace_id, docId: g.doc_id, role: g.role, createdAt: isoOrNull(g.created_at) })),
      }))
    );
    const docRefs = src.docSnapshots.map(s => ({
      workspaceId: s.workspace_id,
      docId: s.guid,
      published: stats.publishedDocs.some(p => p.workspaceId === s.workspace_id && p.docId === s.guid),
    }));
    out.json('instance/old-urls.json', {
      hosts: OLD_HOSTS,
      canonicalHost: OLD_HOSTS[0],
      queryParameters: ['mode=page|edgeless', 'lang=<xx> (published docs with translations)', 'blockIds=<id> / elementIds=<id> (deep links)'],
      paths: oldUrlInventory({
        workspaces: src.workspaces,
        docs: docRefs,
        collections: stats.collections,
        tags: stats.tags,
        blobs: src.blobs.map(b => ({ workspaceId: b.workspace_id, key: b.key })),
      }),
    });

    // ------------------------------------------------------------ checks
    const target = stats.databases.filter(d => d.docTitle === 'Target List');
    const guests = stats.databases.filter(d => d.title === 'Guests');
    const bundleCounts = {
      workspaces: src.workspaces.length,
      users: src.users.length,
      docs: stats.docs,
      blobs: stats.blobsCopied,
      doc_grants: src.docGrants.length,
      translations: stats.translations,
      published_docs: stats.publishedDocs.length,
      comments: stats.comments,
      replies: stats.replies,
      app_configs: configs.length,
    };
    const databaseBlocks = [...stats.flavours.values()].filter(f => f.flavour === 'affine:database').reduce((n, f) => n + f.blocks, 0);
    const checks = [
      ...buildChecks(src.dbCounts, bundleCounts, [
        { key: 'database blocks vs database files', expected: databaseBlocks, actual: stats.databases.length, ok: databaseBlocks === stats.databases.length },
        {
          key: 'Target List: databases with 777 rows x 8 columns',
          expected: target.length,
          actual: target.filter(d => d.rows === 777 && d.columns === 8).length,
          ok: target.length > 0 && target.every(d => d.rows === 777 && d.columns === 8),
        },
        { key: 'database titled "Guests" present', expected: 1, actual: guests.length, ok: guests.length >= 1, note: guests.map(g => `${g.docTitle} (${g.docId})`).join(', ') },
        { key: 'blob files missing or wrong size', expected: 0, actual: stats.blobProblems.length, ok: stats.blobProblems.length === 0 },
      ]),
      ...manifestChecks(readBackupManifest(args['backup-manifest']), src.dbCounts, stats.blobsCopied),
    ];
    out.text('report.md', renderReport({ sourceBackup, stats, checks }));
    out.json('report.json', {
      checks,
      flavours: [...stats.flavours.values()].map(f => ({ flavour: f.flavour, handling: f.handling, blocks: f.blocks, docs: f.docs.size, edgelessOnly: f.edgelessOnly })).sort((a, b) => (a.flavour < b.flavour ? -1 : 1)),
      inlineAttributes: stats.inlineAttributes,
      inlineLatex: stats.inlineLatex,
      databases: stats.databases,
      canvasDocs: stats.canvasDocs,
      notInBody: stats.notInBody,
      blobsUnreferenced: stats.blobsUnreferenced,
      oldHostLinkDocs: stats.oldHostLinkDocs,
    });

    // ---------------------------------------------------------- manifest
    const forkCommit = execFileSync('git', ['-C', serverDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const files = out.listing();
    const manifest = {
      bundleFormat: BUNDLE_FORMAT,
      exporter: { name: 'droneaid/migration/export-affine', version: EXPORTER_VERSION, affineForkCommit: forkCommit },
      sourceBackup,
      counts: {
        workspaces: src.workspaces.length,
        users: src.users.length,
        docs: stats.docs,
        docsByWorkspace: stats.docsByWorkspace,
        trashedDocs: stats.trashed,
        databases: stats.databases.length,
        databaseRows: stats.databases.reduce((n, d) => n + d.rows, 0),
        blobs: stats.blobsCopied,
        blobBytes: stats.blobBytes,
        docGrants: src.docGrants.length,
        agentGrants: agents.reduce((n, a) => n + src.docGrants.filter(g => g.principal_id === a.id).length, 0),
        translations: stats.translations,
        publishedDocs: stats.publishedDocs.length,
        comments: stats.comments,
        replies: stats.replies,
        canvasDocs: stats.canvasDocs.length,
        blockFlavours: new Set([...stats.flavours.values()].map(f => f.flavour)).size,
        files: Object.keys(files).length,
      },
      checksPassed: checks.every(c => c.ok),
      files,
      bundleSha256: sha256(stableJson(files)),
    };
    writeFileSync(`${partial}/manifest.json`, stableJson(manifest), { mode: 0o600 });
    BundleWriter.finish(partial, finalDir);
    lap('total', started);
    // Run details are not part of the hashed content.
    writeFileSync(
      `${finalDir}/run.json`,
      stableJson({ startedAt: new Date(started).toISOString(), host: hostname(), timingsMs: timings }),
      { mode: 0o600 }
    );

    const failed = checks.filter(c => !c.ok);
    console.log(`bundle: ${finalDir}`);
    console.log(`docs ${stats.docs}, databases ${stats.databases.length}, blobs ${stats.blobsCopied}, files ${Object.keys(files).length}, ${timings.total} ms`);
    console.log(`bundleSha256 ${manifest.bundleSha256}`);
    if (failed.length) {
      console.error('CHECKS FAILED:\n' + failed.map(c => `  ${c.key}: expected ${c.expected}, got ${c.actual}`).join('\n'));
      process.exitCode = 2;
    } else {
      console.log(`all ${checks.length} checks passed`);
    }
  } finally {
    await db.$disconnect();
  }
}

await main();
