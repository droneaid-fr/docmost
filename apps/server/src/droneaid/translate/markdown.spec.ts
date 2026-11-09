import {
  matchBlocks,
  normalizeBlock,
  packChunks,
  sameShape,
  splitBlocks,
  unwrapFence,
} from './markdown';

describe('translate markdown: chunking', () => {
  it('packs consecutive blocks up to the limit without cutting one', () => {
    const blocks = [
      'a'.repeat(10),
      'b'.repeat(10),
      'c'.repeat(10),
      'd'.repeat(30),
    ];
    expect(packChunks(blocks, 22)).toEqual([
      ['a'.repeat(10), 'b'.repeat(10)],
      ['c'.repeat(10)],
      ['d'.repeat(30)],
    ]);
  });

  it('keeps every block exactly once, in order', () => {
    const blocks = Array.from({ length: 50 }, (_, i) =>
      `block ${i} `.repeat((i % 7) + 1),
    );
    const chunks = packChunks(blocks, 120);
    expect(chunks.flat()).toEqual(blocks);
    for (const chunk of chunks) {
      if (chunk.length > 1)
        expect(chunk.join('\n\n').length).toBeLessThanOrEqual(120);
    }
  });

  it('splits on blank lines only, and normalises a block to have none', () => {
    expect(splitBlocks('one\ntwo\n\n  \n\nthree\r\n\r\nfour')).toEqual([
      'one\ntwo',
      'three',
      'four',
    ]);
    expect(normalizeBlock(' a\n\n\nb ')).toBe('a\nb');
  });

  it('removes a fence wrapping the whole answer', () => {
    expect(unwrapFence('```markdown\n# Titre\n\nTexte\n```')).toBe(
      '# Titre\n\nTexte',
    );
    expect(unwrapFence('Texte avec `code`')).toBe('Texte avec `code`');
  });
});

describe('translate markdown: structure check', () => {
  it('accepts translated text with the same heading, placeholders and links', () => {
    expect(
      sameShape(
        '## Hello ⟦2⟧ [doc](/p/x-1) ⟦1⟧',
        '## Bonjour ⟦1⟧ [document](/p/x-1) ⟦2⟧',
      ),
    ).toBe(true);
  });

  it.each([
    ['heading level', '## Hello', '### Bonjour'],
    ['heading lost', '# Hello', 'Bonjour'],
    ['placeholder dropped', 'Hi ⟦1⟧', 'Salut'],
    ['placeholder renumbered', 'Hi ⟦1⟧', 'Salut ⟦2⟧'],
    ['link target changed', '[a](https://a.org)', '[a](https://b.org)'],
  ])('rejects %s', (_name, source, translated) => {
    expect(sameShape(source, translated)).toBe(false);
  });

  it('matches block by block, or not at all', () => {
    const source = ['# Title', 'First ⟦1⟧', 'Second'];
    expect(matchBlocks(source, '# Titre\n\nPremier ⟦1⟧\n\nDeuxième')).toEqual([
      '# Titre',
      'Premier ⟦1⟧',
      'Deuxième',
    ]);
    expect(matchBlocks(source, '# Titre\n\nPremier ⟦1⟧ Deuxième')).toBeNull();
    expect(
      matchBlocks(source, '# Titre\n\nPremier\n\nDeuxième ⟦1⟧'),
    ).toBeNull();
  });
});
