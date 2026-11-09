/**
 * report.md / report.json: counts against the source DB and the backup
 * MANIFEST, and every block flavour met with how it is carried.
 */
import { readFileSync } from 'node:fs';

import type { ExportStats } from './export.ts';
import { compareCounts } from './pure.ts';

/** What happens to each flavour, for S6b and for the record of what is lost. */
export const FLAVOUR_NOTES: Record<string, string> = {
  'affine:page': 'Doc root; its title is doc.json `title`.',
  'affine:note': 'Container; children are the body. Notes with displayMode=edgeless are canvas-only (see "edgeless-only").',
  'affine:surface': 'Edgeless canvas; its elements (shapes, connectors, text, mindmaps, groups) go raw to canvas.json. **Lost in Docmost** unless redrawn (e.g. as Excalidraw).',
  'affine:frame': 'Edgeless frame; props in doc.json blocks. **Lost in Docmost** (canvas only).',
  'affine:edgeless-text': 'Edgeless text box; props in doc.json blocks, its text is in its child paragraphs (also canvas-only). **Lost in Docmost** as a canvas element.',
  'affine:paragraph': 'Markdown (text, h1-h6, quote) via the fork reader.',
  'affine:list': 'Markdown list (bulleted, numbered, todo with [ ]/[x]) via the fork reader.',
  'affine:code': 'Fenced code block with language via the fork reader.',
  'affine:divider': 'Markdown `---` via the fork reader.',
  'affine:table': 'GFM table via the fork reader. Cell formatting beyond inline marks is lost; merged cells do not exist in AFFiNE.',
  'affine:image': '`![caption](blob://<key>)` at its position; file in blobs/, width/height/caption in doc.json blocks.',
  'affine:attachment': '`<!-- affine-block ... blob= name= -->` marker; file in blobs/. S6b uploads it as a Docmost attachment.',
  'affine:latex': '`$$ ... $$` block at its position (Docmost math block).',
  'affine:database': 'Fork marker `<!-- database id=... -->` at its position; data in databases/<id>.json.',
  'affine:bookmark': '`<!-- affine-block ... url= title= -->` marker; S6b turns it into a link or embed.',
  'affine:embed-youtube': '`<!-- affine-block ... url= -->` marker; Docmost has a YouTube embed.',
  'affine:embed-synced-doc': '`<!-- affine-block ... target=affine://<docId> -->` marker; Docmost has no synced (transcluded) page in free edition — S6b falls back to a link.',
  'affine:embed-linked-doc': '`<!-- affine-block ... target=affine://<docId> -->` marker; becomes a page link/mention card.',
};

const CANVAS_FLAVOURS = new Set(['affine:surface', 'affine:frame', 'affine:edgeless-text']);

function noteFor(flavour: string, handling: string) {
  const note = FLAVOUR_NOTES[flavour] ?? 'Generic marker; props in doc.json blocks.';
  if (handling === 'canvas' && !CANVAS_FLAVOURS.has(flavour)) {
    return `Placed on the edgeless canvas (child of the surface), so not in body.md; props in doc.json blocks. **Lost in Docmost** as placed; S6b could append it. In a page it would be: ${note}`;
  }
  return note;
}

export function readBackupManifest(path: string | undefined) {
  if (!path) return null;
  const text = readFileSync(path, 'utf8');
  const rows: Record<string, number> = {};
  let section = '';
  for (const line of text.split('\n')) {
    const header = /^\[(.+)\]$/.exec(line.trim());
    if (header) {
      section = header[1];
      continue;
    }
    const m = /^(\S+)\s+(\d+)$/.exec(line.trim());
    if (m && (section === 'row_counts' || section === 'storage')) {
      rows[section === 'storage' ? `storage_${m[1]}` : m[1]] = Number(m[2]);
    }
  }
  const timestamp = /^timestamp:\s*(\S+)/m.exec(text)?.[1] ?? null;
  return { timestamp, rows };
}

type Check = { key: string; expected: number | null; actual: number | null; ok: boolean; note?: string };

export function buildChecks(
  dbCounts: Record<string, number>,
  bundleCounts: Record<string, number>,
  extra: Check[]
): Check[] {
  const pairs: [string, string, string][] = [
    ['workspaces', 'workspaces', 'workspaces'],
    ['users', 'users', 'users'],
    ['docs (snapshots excl. root/db$/userdata$)', 'snapshots_docs', 'docs'],
    ['docs (workspace_pages)', 'workspace_pages', 'docs'],
    ['blobs', 'blobs', 'blobs'],
    ['doc_grants', 'doc_grants', 'doc_grants'],
    ['doc_translations', 'doc_translations', 'translations'],
    ['published docs', 'published_docs', 'published_docs'],
    ['comments', 'comments', 'comments'],
    ['replies', 'replies', 'replies'],
    ['app_configs keys', 'app_configs', 'app_configs'],
  ];
  return [
    ...pairs.map(([label, dbKey, bundleKey]) => ({
      key: label,
      expected: dbCounts[dbKey] ?? null,
      actual: bundleCounts[bundleKey] ?? null,
      ok: dbCounts[dbKey] === bundleCounts[bundleKey],
    })),
    ...extra,
  ];
}

export function manifestChecks(manifest: ReturnType<typeof readBackupManifest>, dbCounts: Record<string, number>, blobFiles: number): Check[] {
  if (!manifest) return [];
  const actual: Record<string, number> = { ...dbCounts, storage_files: blobFiles * 2 };
  const checks: Check[] = compareCounts(manifest.rows, Object.fromEntries(Object.keys(manifest.rows).map(k => [k, actual[k]])))
    .filter(c => c.key !== 'storage_bytes')
    .map(c => ({ ...c, key: `backup MANIFEST ${c.key}` }));
  return checks.map(c =>
    c.key === 'backup MANIFEST storage_files'
      ? { ...c, note: 'each blob is stored with a .metadata.json beside it, so files = 2 x blobs' }
      : c
  );
}

function table(head: string[], rows: (string | number)[][]) {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.map(c => String(c).replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n');
}

export function renderReport(input: {
  sourceBackup: string;
  stats: ExportStats;
  checks: Check[];
}) {
  const { stats, checks } = input;
  const flavours = [...stats.flavours.values()].sort((a, b) => (a.flavour < b.flavour ? -1 : 1));
  const base = (f: string) => f.split(':').slice(0, 2).join(':');
  const lines = [
    `# AFFiNE export report`,
    '',
    `Source backup: \`${input.sourceBackup}\`. Generated by the exporter; deterministic (no timestamps).`,
    '',
    `## Count check`,
    '',
    table(
      ['Check', 'Source', 'Bundle', 'OK', 'Note'],
      checks.map(c => [c.key, c.expected ?? '-', c.actual ?? '-', c.ok ? 'yes' : '**NO**', c.note ?? ''])
    ),
    '',
    `## Block flavours`,
    '',
    'Edgeless-only = inside a note with displayMode=edgeless: hidden in page mode, so not in body.md; their text is in edgeless-notes.md.',
    '',
    'Handling: `markdown` = fork reader output; `image`/`latex`/`database`/`marker` = replaced at its position (see README); `canvas` = edgeless only, not in body.md; `structural` = container.',
    '',
    table(
      ['Flavour', 'Blocks', 'Docs', 'Edgeless-only', 'Handling', 'How it is carried / what is lost'],
      flavours.map(f => [f.flavour, f.blocks, f.docs.size, f.edgelessOnly, f.handling, noteFor(base(f.flavour), f.handling)])
    ),
    '',
    `## Inline formatting`,
    '',
    table(['Attribute', 'Texts using it'], Object.entries(stats.inlineAttributes).sort().map(([k, v]) => [k, v])),
    '',
    `- \`reference\` (page links) become \`[Title](affine://<docId>)\`; \`link\` becomes a Markdown link.`,
    `- \`color\`/\`background\` come out as \`<span style=...>\` HTML from the fork reader; Docmost keeps highlight/colour only if its importer maps the span — treat as **probably lost**.`,
    `- Inline LaTeX: ${stats.inlineLatex} runs rewritten to \`$...$\` (the fork reader would drop them).`,
    '',
    `## Edgeless / canvas content`,
    '',
    stats.canvasDocs.length
      ? table(['Doc', 'Title', 'Elements'], stats.canvasDocs.map(d => [d.docId, d.title, Object.entries(d.elements).sort().map(([k, v]) => `${k} ${v}`).join(', ')]))
      : 'None.',
    '',
    `Special blocks printed in neither body.md nor edgeless-notes.md: ${stats.notInBody.length}${stats.notInBody.length ? ' — ' + stats.notInBody.map(b => `${b.docId}/${b.blockId} (${b.flavour})`).join(', ') : ''}.`,
    '',
    `## Databases`,
    '',
    table(['Doc', 'Database', 'Title', 'Rows', 'Columns'], stats.databases.map(d => [`${d.docTitle} (${d.docId})`, d.databaseId, d.title, d.rows, d.columns])),
    '',
    `## Other findings`,
    '',
    `- Native reader "known unsupported" per doc: ${JSON.stringify(stats.readerUnsupported)}; unknown flavours: ${JSON.stringify(stats.readerUnknown)}.`,
    `- Special blocks whose children were dropped: ${stats.childrenDropped.length ? JSON.stringify(stats.childrenDropped) : 'none'}.`,
    `- Orphan blocks (not reachable from the page block, ignored by the reader): ${stats.orphanBlocks}.`,
    `- Root-meta pages without a snapshot: ${stats.metaWithoutSnapshot.length ? stats.metaWithoutSnapshot.join('; ') : 'none'}.`,
    `- Trashed docs exported (flagged \`trash: true\`): ${stats.trashed}.`,
    `- Blob problems: ${stats.blobProblems.length ? stats.blobProblems.join('; ') : 'none'}.`,
    `- Blobs referenced by no block (exported anyway): ${stats.blobsUnreferenced.length}.`,
    `- Block references to blobs absent from the blobs table: ${stats.blobRefsWithoutBlob.length ? stats.blobRefsWithoutBlob.join('; ') : 'none'}.`,
    `- Docs with absolute links to the old host: ${stats.oldHostLinkDocs.length ? stats.oldHostLinkDocs.map(d => `${d.docId} (${d.links.length})`).join(', ') : 'none'}.`,
    '',
  ];
  return lines.join('\n');
}
