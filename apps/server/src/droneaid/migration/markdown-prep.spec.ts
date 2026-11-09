import { mapColor, nestMathInLists, parseBlockMarker, prepareMarkdown } from './markdown-prep';

const ctx = {
  attachmentFor: (key: string) => (key === 'Ab_c-1=' ? '0190f2c4-0000-7000-8000-000000000001' : null),
  titleOf: (docId: string) => (docId === 'doc2' ? 'Second doc' : null),
};

describe('prepareMarkdown', () => {
  it('maps AFFiNE colour variables to Docmost text colours', () => {
    expect(mapColor('color: var(--affine-v2-text-highlight-fg-yellow)')).toBe('#EAB308');
    expect(mapColor('color: var(--affine-text-highlight-foreground-orange)')).toBe('#FFA500');
    expect(mapColor('color: var(--affine-something)')).toBeNull();
    const { markdown, stats } = prepareMarkdown(
      'a <span style="color: var(--affine-v2-text-highlight-fg-blue)">b</span> <span style="color: var(--x)">c</span>',
      ctx,
    );
    expect(markdown).toBe('a <span style="color: #2563EB">b</span> <span>c</span>');
    expect(stats).toMatchObject({ colorSpans: 2, colorSpansDropped: 1 });
  });

  it('rewrites blob keys to attachment ids and reports unknown ones', () => {
    const { markdown, stats } = prepareMarkdown('![](blob://Ab_c-1=)\n\n![](blob://nope=)', ctx);
    expect(markdown).toBe('![](blob://0190f2c4-0000-7000-8000-000000000001)\n\n![](blob://nope=)');
    expect(stats.missingBlobs).toEqual(['nope=']);
  });

  it('turns block markers into tokens or links, never inside code fences', () => {
    const body = [
      '<!-- affine-block id=b1 flavour=affine:attachment blob="Ab_c-1=" name="A%20b.pdf" -->',
      '<!-- affine-block id=b2 flavour=affine:bookmark url="https://x.org/a" title="X" -->',
      '<!-- affine-block id=b3 flavour=affine:embed-synced-doc target="affine://doc2" -->',
      '<!-- affine-block id=b4 flavour=affine:embed-youtube url="https://youtu.be/abc" -->',
      '<!-- affine-block id=b5 flavour=affine:embed-figma -->',
      '```',
      '<!-- affine-block id=b6 flavour=affine:bookmark url="https://y" -->',
      '```',
    ].join('\n');
    const { markdown, tokens, stats, affineLinks } = prepareMarkdown(body, ctx);
    expect(markdown).toContain('\nDRONEAIDMIG:attachment:b1\n');
    expect(markdown).toContain('[X](https://x.org/a)');
    expect(markdown).toContain('[Second doc](affine://doc2)');
    expect(markdown).toContain('\nDRONEAIDMIG:youtube:b4\n');
    expect(markdown).toContain('<!-- affine-block id=b6 flavour=affine:bookmark url="https://y" -->');
    expect(tokens.map((t) => [t.kind, t.attrs.name ?? t.attrs.url])).toEqual([
      ['attachment', 'A b.pdf'],
      ['youtube', 'https://youtu.be/abc'],
    ]);
    expect(stats.markersDropped).toEqual(['affine:embed-figma b5']);
    expect(affineLinks).toEqual(['doc2']);
  });

  it('appends canvas notes and canvas embeds under a heading', () => {
    const { markdown } = prepareMarkdown('Body', ctx, {
      edgelessNotes: '# Organize\n\n* folder',
      canvasBlocks: [
        { id: 'c1', flavour: 'affine:bookmark', handling: 'canvas', parentId: null, props: { url: 'https://a.b', title: 'AB' } },
        { id: 'c2', flavour: 'affine:frame', handling: 'canvas', parentId: null, props: {} },
        { id: 'c3', flavour: 'affine:embed-synced-doc', handling: 'canvas', parentId: null, props: { pageId: 'doc2' } },
      ],
    });
    expect(markdown).toBe(
      'Body\n\n## Canvas notes\n\n# Organize\n\n* folder\n\n[AB](https://a.b)\n\n[Second doc](affine://doc2)\n',
    );
  });

  it('parses marker attributes', () => {
    expect(parseBlockMarker('<!-- affine-block id=x flavour=affine:bookmark url="a%22b" -->')).toEqual({
      id: 'x',
      flavour: 'affine:bookmark',
      attrs: { url: 'a"b' },
    });
    expect(parseBlockMarker('<!-- database id=x -->')).toBeNull();
  });
});

describe('nestMathInLists', () => {
  it('indents a column-0 maths block into the list item before it', () => {
    const md = ['* a', '    1. one:', '$$', 'x = 1', '$$', '', '    2. two', '', 'After', '$$', 'y', '$$'].join('\n');
    expect(nestMathInLists(md).split('\n')).toEqual([
      '* a', '    1. one:', '       $$', '       x = 1', '       $$', '', '    2. two', '', 'After', '$$', 'y', '$$',
    ]);
  });
});
