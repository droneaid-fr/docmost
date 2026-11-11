import type { Bundle } from './bundle';
import type { GrantReview, SkippedMember, SkippedUser } from './roles';
import type { UnmappedUrl, UrlMapEntry } from './url-map';

/** What one import run did, written to `<out>/import-report.{json,md}`. */
export type ImportReport = {
  bundle: { dir: string; sha256: string; counts: Record<string, any> };
  options: { ownerEmail: string; workspaceName: string; skipTrashed: boolean; agent: string | null };
  workspace: { id: string; name: string } | null;
  workspaceCreated: boolean;
  rerun: boolean;
  created: Record<string, number>;
  skippedExisting: Record<string, number>;
  spaces: { workspaceId: string; name: string; spaceId: string; slug: string; members: string[] }[];
  skippedUsers: SkippedUser[];
  skippedMembers: SkippedMember[];
  grantsNotReproduced: GrantReview[];
  agent: {
    userId: string;
    email: string;
    name: string;
    writableSpace: string;
    readerSpaces: { space: string; grants: number }[];
    ownGrants: number;
  } | null;
  multiFolderDocs: { workspace: string; docId: string; title: string; keptUnder: string; alsoIn: string[] }[];
  skippedFolderLinks: { workspace: string; folder: string; type: string; targetId: string }[];
  creatorFallbacks: { docId: string; affineCreator: string | null; usedInstead: string }[];
  databases: {
    docId: string;
    docTitle: string;
    databaseId: string;
    title: string;
    rows: number;
    columns: number;
    bundleRows: number;
    bundleColumns: number;
    renamedIds: number;
    invalidCells: number;
    hiddenColumns: string[];
    notes: string[];
  }[];
  formatting: {
    colorSpans: number;
    colorSpansDropped: number;
    backgroundDropped: number;
    markers: Record<string, number>;
    markersDropped: string[];
    canvasBlocksDropped: number;
  };
  resolvedLinks: number;
  unresolvedLinks: { docId: string; title: string; target: string }[];
  missingBlobs: { docId: string; key: string }[];
  trashed: { docId: string; title: string; affineTrashDate: string | null }[];
  trashedSkipped: number;
  comments: { docId: string; commentId: string; resolved: boolean; reply: boolean }[];
  signupRules: {
    rules: { pattern: string; spaceRole: string; spaces: string[] }[];
    skipped: { pattern: string; reason: string }[];
  } | null;
  unreferencedBlobs: { workspace: string; key: string; mime: string; size: number; avatar: boolean }[];
  canvasOnlyBlobs: { workspace: string; key: string; docs: string[] }[];
  urlMap: { mapped: UrlMapEntry[]; unmapped: UnmappedUrl[] } | null;
  excludedWorkspaces: Bundle['excluded'];
  defaultSpaceRemoved: { id: string; name: string; slug: string } | null;
  warnings: string[];
  timingsMs: { total: number; pages: Record<string, number> };
};

export function newReport(
  bundle: Bundle,
  opts: { ownerEmail: string; workspaceName: string; skipTrashed: boolean; agent: { name: string } | null },
): ImportReport {
  const unreferencedBlobs: ImportReport['unreferencedBlobs'] = [];
  const canvasOnlyBlobs: ImportReport['canvasOnlyBlobs'] = [];
  for (const ws of bundle.workspaces) {
    const blockHandling = new Map<string, string>();
    for (const doc of ws.docs) {
      for (const b of doc.blocks ?? []) blockHandling.set(`${doc.docId}/${b.id}`, b.handling);
    }
    for (const blob of ws.blobs) {
      const refs = blob.referencedBy ?? [];
      if (!refs.length) {
        unreferencedBlobs.push({
          workspace: ws.workspace.name,
          key: blob.key,
          mime: blob.mime,
          size: blob.size,
          avatar: blob.workspaceAvatar,
        });
      } else if (refs.every((r) => blockHandling.get(`${r.docId}/${r.blockId}`) === 'canvas')) {
        canvasOnlyBlobs.push({
          workspace: ws.workspace.name,
          key: blob.key,
          docs: [...new Set(refs.map((r) => r.docId))],
        });
      }
    }
  }
  return {
    bundle: { dir: bundle.dir, sha256: bundle.sha256, counts: bundle.counts },
    options: {
      ownerEmail: opts.ownerEmail.toLowerCase(),
      workspaceName: opts.workspaceName,
      skipTrashed: opts.skipTrashed,
      agent: opts.agent?.name ?? null,
    },
    workspace: null,
    workspaceCreated: false,
    rerun: false,
    created: {},
    skippedExisting: {},
    spaces: [],
    skippedUsers: [],
    skippedMembers: [],
    grantsNotReproduced: [],
    agent: null,
    multiFolderDocs: [],
    skippedFolderLinks: [],
    creatorFallbacks: [],
    databases: [],
    formatting: {
      colorSpans: 0,
      colorSpansDropped: 0,
      backgroundDropped: 0,
      markers: {},
      markersDropped: [],
      canvasBlocksDropped: 0,
    },
    resolvedLinks: 0,
    unresolvedLinks: [],
    missingBlobs: [],
    trashed: [],
    trashedSkipped: 0,
    comments: [],
    signupRules: null,
    unreferencedBlobs,
    canvasOnlyBlobs,
    urlMap: null,
    excludedWorkspaces: bundle.excluded,
    defaultSpaceRemoved: null,
    warnings: [],
    timingsMs: { total: 0, pages: {} },
  };
}

const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return '_none_\n';
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    '',
  ].join('\n');
}

export function reportMarkdown(r: ImportReport): string {
  const review = r.grantsNotReproduced.filter((g) => g.effect !== 'same');
  const out = [
    '# AFFiNE -> Docmost import report',
    '',
    `Bundle \`${r.bundle.sha256}\`; workspace ${r.workspace?.name} (${r.workspace?.id})` +
      `${r.workspaceCreated ? ', created by this run' : ''}${r.rerun ? '; re-run (existing objects skipped)' : ''}.`,
    '',
    '## Created',
    table(['Object', 'Created', 'Already there'], [
      ...new Set([...Object.keys(r.created), ...Object.keys(r.skippedExisting)]),
    ].sort().map((k) => [k, r.created[k] ?? 0, r.skippedExisting[k] ?? 0])),
    '## Workspaces not migrated',
    table(
      ['AFFiNE workspace', 'Members', 'Docs (live / trashed)', 'Folders', 'Databases', 'Files (blobs, bytes)', 'Published', 'Doc grants', 'Old URLs -> /home'],
      r.excludedWorkspaces.map((w) => [
        `${w.name} (${w.id})`, w.members.join(', '), `${w.docs} / ${w.trashedDocs}`, w.folders, w.databases,
        `${w.blobs}, ${w.blobBytes} B`, w.publishedDocs, w.docGrants, w.oldUrls,
      ]),
    ),
    `Default space of setup: ${r.defaultSpaceRemoved ? `"${r.defaultSpaceRemoved.name}" removed, workspaces.default_space_id = null` : 'not removed (see warnings) or already gone'}.`,
    '',
    '## Spaces',
    table(['AFFiNE workspace', 'Space slug', 'Members'], r.spaces.map((s) => [s.name, s.slug, s.members.join(', ')])),
    '## Agent',
    r.agent
      ? `${r.agent.name} <${r.agent.email}>: writer in \`${r.agent.writableSpace}\`; reader in ${
          r.agent.readerSpaces.map((s) => `${s.space} (${s.grants} grants)`).join(', ') || 'no other space'
        }. Its ${r.agent.ownGrants} AFFiNE doc grants were all in its own workspace. No token minted.\n`
      : '_not created_\n',
    '## Per-doc grants to review (not reproduced)',
    table(['Workspace', 'Doc', 'Who', 'Grant', 'Space role', 'Effect', 'Note'], review.map((g) => [
      g.workspace, `${g.docTitle ?? ''} (${g.docId})`, g.email ?? '-', g.grantRole, g.spaceRole ?? '-', g.effect, g.note,
    ])),
    `${r.grantsNotReproduced.length - review.length} other human grants are covered by the space roles (owner grants of space members).`,
    '',
    '## Skipped users',
    table(['Email', 'Reason'], r.skippedUsers.map((u) => [u.email, u.reason])),
    '## Skipped memberships',
    table(['Workspace', 'Email', 'Role', 'State', 'Reason'], r.skippedMembers.map((m) => [m.workspace, m.email, m.role, m.state, m.reason])),
    '## Docs linked from several folders',
    table(['Workspace', 'Doc', 'Placed under', 'Also linked in'], r.multiFolderDocs.map((d) => [d.workspace, `${d.title} (${d.docId})`, d.keptUnder, d.alsoIn.join('; ')])),
    '## Folder links not reproduced (tags, collections, docs missing from the bundle)',
    table(['Workspace', 'Folder', 'Type', 'Target'], r.skippedFolderLinks.map((l) => [l.workspace, l.folder, l.type, l.targetId])),
    '## Databases',
    table(['Doc', 'Database', 'Rows', 'Columns', 'Bundle rows x cols', 'Ids replaced', 'Invalid cells', 'Hidden columns (shown in Docmost)', 'Notes'],
      r.databases.map((d) => [`${d.docTitle} (${d.docId})`, `${d.title} (${d.databaseId})`, d.rows, d.columns, `${d.bundleRows}x${d.bundleColumns}`, d.renamedIds, d.invalidCells, d.hiddenColumns.length, d.notes.join('; ')])),
    '## Formatting',
    `- colour spans: ${r.formatting.colorSpans} (mapped to Docmost text colours; ${r.formatting.colorSpansDropped} without a recognisable colour lost it)`,
    `- background highlights dropped (not in the exported Markdown): ${r.formatting.backgroundDropped}`,
    `- block markers: ${JSON.stringify(r.formatting.markers)}; dropped: ${r.formatting.markersDropped.join(', ') || 'none'}`,
    `- canvas-only blocks dropped (frames, shapes' text boxes, canvas images): ${r.formatting.canvasBlocksDropped}`,
    '',
    `## Page links: ${r.resolvedLinks} resolved, ${r.unresolvedLinks.length} unresolved`,
    table(['Doc', 'Target'], r.unresolvedLinks.map((l) => [`${l.title} (${l.docId})`, l.target])),
    '## Creator fallbacks (AFFiNE creator not a Docmost user)',
    table(['Doc', 'AFFiNE creator', 'Used'], r.creatorFallbacks.map((c) => [c.docId, c.affineCreator ?? '-', c.usedInstead])),
    `## Trashed docs (${r.trashed.length}; Docmost purges trash after 30 days)`,
    table(['Doc', 'Title', 'AFFiNE trash date'], r.trashed.map((t) => [t.docId, t.title, t.affineTrashDate ?? '-'])),
    '## Comments',
    table(['Doc', 'Comment', 'Resolved in AFFiNE', 'Reply'], r.comments.map((c) => [c.docId, c.commentId, c.resolved, c.reply])),
    '## Signup rules',
    table(['Pattern', 'Space role', 'Spaces'], (r.signupRules?.rules ?? []).map((s) => [s.pattern, s.spaceRole, s.spaces.join(', ')])),
    `## Blobs not imported: ${r.unreferencedBlobs.length} unreferenced, ${r.canvasOnlyBlobs.length} only on a canvas`,
    table(['Workspace', 'Key', 'Why'], [
      ...r.unreferencedBlobs.map((b) => [b.workspace, b.key, b.avatar ? 'workspace avatar' : `unreferenced (${b.mime}, ${b.size} B)`]),
      ...r.canvasOnlyBlobs.map((b) => [b.workspace, b.key, `canvas image in ${b.docs.join(', ')}`]),
    ]),
    `## URL map: ${r.urlMap?.mapped.length ?? 0} mapped, ${r.urlMap?.unmapped.length ?? 0} unmapped`,
    table(['Old path', 'Kind', 'Reason'], (r.urlMap?.unmapped ?? []).map((u) => [u.from, u.kind, u.reason])),
    '## Warnings',
    r.warnings.length ? r.warnings.map((w) => `- ${w}`).join('\n') + '\n' : '_none_\n',
    `Total time: ${r.timingsMs.total} ms.`,
    '',
  ];
  return out.join('\n');
}
