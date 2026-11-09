import {
  TranslationStructureError,
  translateBlocks,
  systemPrompt,
} from './translator';

describe('translateBlocks', () => {
  const upper = async (_system: string, user: string) =>
    user.replace(/[a-z]+/g, (w) => w.toUpperCase());

  it('translates chunk by chunk, keeping one block per source block', async () => {
    const calls: string[] = [];
    const generate = async (system: string, user: string) => {
      calls.push(user);
      return upper(system, user);
    };
    const blocks = ['# title', 'alpha ⟦1⟧', 'beta', 'gamma'];
    const out = await translateBlocks({
      blocks,
      from: 'en',
      to: 'fr',
      generate,
      maxChunkChars: 16,
    });
    expect(out).toEqual(['# TITLE', 'ALPHA ⟦1⟧', 'BETA', 'GAMMA']);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('retries a chunk once when the structure changed', async () => {
    let n = 0;
    const generate = async (_s: string, user: string) =>
      ++n === 1 ? user.replace(/\n\n/g, ' ') : user.toUpperCase();
    const out = await translateBlocks({
      blocks: ['one', 'two'],
      from: 'en',
      to: 'fr',
      generate,
    });
    expect(out).toEqual(['ONE', 'TWO']);
    expect(n).toBe(2);
  });

  it('fails with a clear reason after two bad answers', async () => {
    let n = 0;
    const generate = async () => {
      n++;
      return 'merged';
    };
    await expect(
      translateBlocks({
        blocks: ['one', 'two'],
        from: 'en',
        to: 'fr',
        generate,
      }),
    ).rejects.toBeInstanceOf(TranslationStructureError);
    expect(n).toBe(2);
  });

  it('names both languages in the prompt', () => {
    expect(systemPrompt('fr', 'en')).toContain('from French to English');
  });
});
