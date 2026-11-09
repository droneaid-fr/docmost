/**
 * One AFFiNE doc (a Yjs snapshot) → body markdown, block inventory,
 * databases and canvas content. Uses the fork's own reader and database model
 * (see fork.ts); the original Y.Doc is never modified, all rewrites happen on
 * copies.
 */
import type * as YT from 'yjs';

import type { Fork } from './fork.ts';
import {
  blockMarker,
  type DeltaOp,
  deltaAttributes,
  type Handling,
  handlingOf,
  imageMarkdown,
  inlineLatexToText,
  latexMarkdown,
  needsSentinel,
  replaceSentinels,
  tidyMarkdown,
} from './pure.ts';

type Block = YT.Map<unknown>;

export type BlockEntry = {
  id: string;
  flavour: string;
  type?: string;
  parentId: string | null;
  handling: Handling;
  /** In a note shown only on the edgeless canvas (`displayMode: edgeless`). */
  edgelessOnly?: boolean;
  /** Props kept for S6b (special blocks only). */
  props?: Record<string, unknown>;
  /** What the block became in body.md. */
  representation?: string;
  childrenDropped?: number;
};

/** Props too large or internal to repeat in doc.json. */
const SKIPPED_PROPS = new Set([
  'prop:text',
  'prop:cells',
  'prop:columns',
  'prop:views',
  'prop:elements',
  'prop:index',
  'prop:lockedBySelf',
  'prop:rotate',
]);

function plainProps(fork: Fork, block: Block) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of block) {
    if (!key.startsWith('prop:') || SKIPPED_PROPS.has(key)) continue;
    if (key.startsWith('prop:meta:')) continue;
    out[key.slice(5)] = value instanceof fork.Y.AbstractType ? value.toJSON() : value;
  }
  return out;
}

function str(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'toString' in (value as object)) return String(value);
  return String(value);
}

/** Document-order walk from the page block; orphans (unreachable blocks) last. */
export function walkBlocks(fork: Fork, doc: YT.Doc) {
  const { Y } = fork;
  const blocks = doc.getMap('blocks') as YT.Map<Block>;
  const order: { id: string; block: Block; parentId: string | null; onCanvas: boolean; edgelessOnly: boolean }[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentId: string | null, onCanvas: boolean, edgelessOnly: boolean) => {
    if (seen.has(id)) return;
    const block = blocks.get(id);
    if (!(block instanceof Y.Map)) return;
    seen.add(id);
    const flavour = String(block.get('sys:flavour'));
    const canvas = onCanvas || flavour === 'affine:surface';
    const hidden =
      edgelessOnly || (flavour === 'affine:note' && block.get('prop:displayMode') === 'edgeless');
    order.push({ id, block, parentId, onCanvas: canvas, edgelessOnly: hidden });
    for (const child of fork.childIds(block)) visit(child, id, canvas, hidden);
  };
  const roots = [...blocks.entries()]
    .filter(([, b]) => b instanceof Y.Map && b.get('sys:flavour') === 'affine:page')
    .map(([id]) => id)
    .sort();
  roots.forEach(id => visit(id, null, false, false));
  const orphans = [...blocks.keys()].filter(id => !seen.has(id)).sort();
  orphans.forEach(id => visit(id, null, false, false));
  return { order, orphans };
}

/** The line(s) a special block becomes in body.md. */
function representationOf(fork: Fork, id: string, flavour: string, block: Block): string {
  const p = (key: string) => block.get(`prop:${key}`);
  switch (handlingOf(flavour)) {
    case 'image':
      return imageMarkdown(String(p('sourceId') ?? ''), str(p('caption')) ?? '');
    case 'latex':
      return latexMarkdown(String(p('latex') ?? ''));
    case 'database': {
      const columns = fork.columnsOf(block).length;
      return fork.databaseMarker({
        id,
        title: str(p('title')) ?? '',
        rows: fork.childIds(block).length,
        columns,
      });
    }
    default: {
      const pageId = str(p('pageId'));
      return blockMarker(id, flavour, {
        url: str(p('url')),
        target: pageId ? `affine://${pageId}` : undefined,
        blob: str(p('sourceId')),
        name: str(p('name')),
        title: str(p('title')),
      });
    }
  }
}

export type InlineStats = { attributes: Record<string, number>; inlineLatex: number };

/**
 * Body markdown the way read_document builds it, extended:
 * - every block markdown cannot carry is replaced by a sentinel before the
 *   native reader runs (the trick database-markdown.ts uses for databases), so
 *   it keeps its position and becomes an image, `$$` block, database marker or
 *   `<!-- affine-block ... -->` line;
 * - inline LaTeX (dropped by the reader) becomes `$...$` text;
 * - page links become `[Title](affine://<docId>)` (renderReadReferences).
 */
export function docBody(
  fork: Fork,
  workspaceId: string,
  docId: string,
  doc: YT.Doc,
  titleOf: (docId: string) => string | undefined
) {
  const { Y } = fork;
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const blocks = copy.getMap('blocks') as YT.Map<Block>;
    const { order, orphans } = walkBlocks(fork, copy);
    const entries: BlockEntry[] = [];
    const replacements = new Map<string, string>();
    const stats: InlineStats = { attributes: {}, inlineLatex: 0 };
    const toSentinel: { id: string; block: Block; flavour: string }[] = [];

    for (const { id, block, parentId, onCanvas, edgelessOnly } of order) {
      const flavour = String(block.get('sys:flavour'));
      const handling = handlingOf(flavour, onCanvas);
      const entry: BlockEntry = { id, flavour, parentId, handling };
      const type = block.get('prop:type');
      if (typeof type === 'string' && (flavour === 'affine:paragraph' || flavour === 'affine:list')) {
        entry.type = type;
      }
      if (edgelessOnly) entry.edgelessOnly = true;
      if (handling !== 'markdown' && handling !== 'structural') {
        entry.props = plainProps(fork, block);
      }
      if (needsSentinel(handling)) {
        entry.representation = representationOf(fork, id, flavour, block);
        const children = fork.childIds(block).length;
        if (children && handling !== 'database') entry.childrenDropped = children;
        toSentinel.push({ id, block, flavour });
        replacements.set(fork.blockSentinel(id), entry.representation);
      }
      entries.push(entry);
    }

    copy.transact(() => {
      for (const { id } of toSentinel) {
        const drop = (blockId: string) => {
          fork.childIds(blocks.get(blockId)).forEach(drop);
          blocks.delete(blockId);
        };
        fork.childIds(blocks.get(id)).forEach(drop);
        const sentinel = new Y.Map<unknown>();
        sentinel.set('sys:id', id);
        sentinel.set('sys:flavour', 'affine:paragraph');
        sentinel.set('sys:version', 1);
        sentinel.set('sys:children', new Y.Array<string>());
        sentinel.set('prop:type', 'text');
        sentinel.set('prop:text', new Y.Text(fork.blockSentinel(id)));
        blocks.set(id, sentinel);
      }
      // Inline LaTeX and inline attribute statistics, on every remaining text.
      for (const [, block] of blocks) {
        if (!(block instanceof Y.Map)) continue;
        for (const [, value] of block) {
          if (!(value instanceof Y.Text)) continue;
          const delta = value.toDelta() as DeltaOp[];
          for (const name of deltaAttributes(delta)) {
            stats.attributes[name] = (stats.attributes[name] ?? 0) + 1;
          }
          const rewritten = inlineLatexToText(delta);
          if (rewritten.count) {
            stats.inlineLatex += rewritten.count;
            value.delete(0, value.length);
            value.applyDelta(rewritten.delta);
          }
        }
      }
    });

    // Page mode hides notes whose displayMode is "edgeless", but the reader
    // prints them. body.md gets what page mode shows; the edgeless-only notes
    // go to edgeless-notes.md so their text is not lost.
    const pageEntry = order.find(o => o.parentId === null && o.block.get('sys:flavour') === 'affine:page');
    const pageChildren = pageEntry ? fork.childIds(pageEntry.block) : [];
    const isNote = (id: string) => blocks.get(id)?.get('sys:flavour') === 'affine:note';
    const hiddenNotes = pageChildren.filter(id => isNote(id) && blocks.get(id)?.get('prop:displayMode') === 'edgeless');
    const shownNotes = pageChildren.filter(id => isNote(id) && !hiddenNotes.includes(id));
    const prepared = Y.encodeStateAsUpdate(copy);

    const render = (removeNotes: string[]) => {
      const variant = new Y.Doc();
      try {
        Y.applyUpdate(variant, prepared);
        const vblocks = variant.getMap('blocks') as YT.Map<Block>;
        if (pageEntry && removeNotes.length) {
          variant.transact(() => {
            const children = vblocks.get(pageEntry.id)?.get('sys:children');
            if (children instanceof Y.Array) {
              const list = children.toArray() as string[];
              for (let i = list.length - 1; i >= 0; i--) {
                if (removeNotes.includes(list[i])) children.delete(i, 1);
              }
            }
            const drop = (blockId: string) => {
              fork.childIds(vblocks.get(blockId)).forEach(drop);
              vblocks.delete(blockId);
            };
            removeNotes.forEach(drop);
          });
        }
        const parsed = fork.parseDocToMarkdown(workspaceId, docId, Y.encodeStateAsUpdate(variant));
        const replaced = replaceSentinels(parsed.markdown, replacements);
        return {
          parsed,
          printed: [...replacements.keys()].filter(s => parsed.markdown.includes(s)),
          missing: replaced.missing,
          markdown: tidyMarkdown(fork.renderReadReferences(replaced.markdown, workspaceId, titleOf)),
        };
      } finally {
        variant.destroy();
      }
    };

    const body = render(hiddenNotes);
    const edgeless = hiddenNotes.length ? render(shownNotes) : null;
    const printed = new Set([...body.printed, ...(edgeless?.printed ?? [])]);
    for (const entry of entries) {
      if (entry.representation && !printed.has(fork.blockSentinel(entry.id))) {
        entry.representation = `(not printed) ${entry.representation}`;
      }
    }
    const parsed = body.parsed;
    return {
      title: parsed.title,
      markdown: body.markdown,
      edgelessNotesMarkdown: edgeless?.markdown ?? null,
      edgelessNotes: hiddenNotes,
      blocks: entries,
      orphanBlocks: orphans.length,
      inline: stats,
      readerUnsupported: [...new Set(parsed.knownUnsupportedBlocks.map(e => e.split(':').slice(1).join(':')))].sort(),
      readerUnknown: [...new Set(parsed.unknownBlocks.map(e => e.split(':').slice(1).join(':')))].sort(),
      unplacedSentinels: [...body.missing, ...(edgeless?.missing ?? [])],
    };
  } finally {
    copy.destroy();
  }
}

/**
 * A translation snapshot (doc_translations.bin) through the same pipeline as
 * the source doc, so images, LaTeX and markers look the same in both.
 */
export function translationBody(
  fork: Fork,
  workspaceId: string,
  docId: string,
  bin: Uint8Array,
  titleOf: (docId: string) => string | undefined
) {
  const doc = new fork.Y.Doc();
  try {
    fork.Y.applyUpdate(doc, bin);
    const body = docBody(fork, workspaceId, docId, doc, titleOf);
    return { title: body.title, markdown: body.markdown };
  } finally {
    doc.destroy();
  }
}

// ------------------------------------------------------------- databases

function richDelta(fork: Fork, value: unknown): DeltaOp[] | null {
  if (!(value instanceof fork.Y.Text)) return null;
  const delta = value.toDelta() as DeltaOp[];
  return delta.some(op => op.attributes && Object.keys(op.attributes).length) ? delta : null;
}

/**
 * Every database in the doc, read with the fork's database model
 * (database-model.ts / database-edit.ts, the code behind read_database):
 * dates `YYYY-MM-DD`, selects as labels, checkbox always true/false. Unlike
 * read_database, every column is present in every row (empty = null, '' or []).
 */
export function docDatabases(fork: Fork, doc: YT.Doc) {
  const { Y } = fork;
  // readRows/cellsOf create missing maps; work on a copy.
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const blocks = copy.getMap('blocks') as YT.Map<Block>;
    return fork.findDatabases(copy).map(({ id, block, title }) => {
      const columns = fork.columnsOf(block) as { id: string; type: string; name: string; data: YT.Map<unknown>; virtual?: boolean }[];
      const keys = fork.columnKeys(columns) as Map<string, string>;
      const described = fork.describeColumns(block) as Record<string, unknown>[];
      const titleColumn = columns.find(c => c.type === 'title');
      const titleKey = titleColumn ? keys.get(titleColumn.id) ?? titleColumn.id : null;
      const read = fork.readRows(block) as { id: string; values: Record<string, unknown> }[];
      const titles = new Map(read.map(r => [r.id, titleKey ? r.values[titleKey] : undefined]));
      const cells = block.get('prop:cells');
      const rows = fork.childIds(block).map(rowId => {
        const rowCells = cells instanceof Y.Map ? (cells.get(rowId) as YT.Map<YT.Map<unknown>> | undefined) : undefined;
        const values: Record<string, unknown> = {};
        const richText: Record<string, DeltaOp[]> = {};
        for (const column of columns) {
          if (column.type === 'title') {
            values[column.id] = titles.get(rowId) ?? '';
            const delta = richDelta(fork, blocks.get(rowId)?.get('prop:text'));
            if (delta) richText[column.id] = delta;
            continue;
          }
          const raw = rowCells instanceof Y.Map ? rowCells.get(column.id)?.get('value') : undefined;
          values[column.id] = fork.decodeCell(column, raw);
          const delta = richDelta(fork, raw);
          if (delta) richText[column.id] = delta;
        }
        return Object.keys(richText).length ? { id: rowId, values, richText } : { id: rowId, values };
      });
      const views = block.get('prop:views');
      return {
        databaseId: id,
        title,
        columns: described.map((info, i) => ({
          ...info,
          ...(columns[i].virtual ? { virtual: true } : {}),
          // A column without stored data gets a detached Y.Map from columnsOf.
          data: columns[i].data instanceof Y.Map && columns[i].data.doc ? columns[i].data.toJSON() : {},
        })),
        rowCount: rows.length,
        rows,
        views: views instanceof Y.AbstractType ? views.toJSON() : (views ?? []),
      };
    });
  } finally {
    copy.destroy();
  }
}

// ---------------------------------------------------------------- canvas

/** Surface elements (shapes, connectors, text, mindmaps, groups) as raw JSON. */
export function docCanvas(fork: Fork, doc: YT.Doc) {
  const { Y } = fork;
  const blocks = doc.getMap('blocks') as YT.Map<Block>;
  for (const [id, block] of blocks) {
    if (!(block instanceof Y.Map) || block.get('sys:flavour') !== 'affine:surface') continue;
    const elements = (block.get('prop:elements') as YT.Map<unknown> | undefined)?.get?.('value');
    if (!(elements instanceof Y.Map) || elements.size === 0) return null;
    const out: Record<string, unknown> = {};
    for (const [eid, element] of elements) {
      out[eid] = element instanceof Y.AbstractType ? element.toJSON() : element;
    }
    return { surfaceId: id, elements: out };
  }
  return null;
}
