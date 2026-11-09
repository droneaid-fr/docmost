import { createGeminiClient, GeminiRateLimited } from './gemini';

function fakeFetch(status: number, body: unknown) {
  const calls: any[] = [];
  const fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return { status, ok: status < 400, json: async () => body } as any;
  }) as any;
  return { fetch, calls };
}

describe('gemini client', () => {
  const opts = {
    apiKey: 'k',
    model: 'm-1',
    baseUrl: 'http://fake/v1beta/models',
  };

  it('posts the prompt and returns the text', async () => {
    const { fetch, calls } = fakeFetch(200, {
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'Bon' }, { text: 'jour' }] },
        },
      ],
    });
    const generate = createGeminiClient({ ...opts, fetch });
    expect(await generate('sys', 'Hello')).toBe('Bonjour');
    expect(calls[0].url).toBe('http://fake/v1beta/models/m-1:generateContent');
    expect(calls[0].init.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(calls[0].init.body).contents[0].parts[0].text).toBe(
      'Hello',
    );
  });

  it('maps 429 to GeminiRateLimited', async () => {
    const { fetch } = fakeFetch(429, { error: { message: 'quota' } });
    await expect(
      createGeminiClient({ ...opts, fetch })('s', 'u'),
    ).rejects.toBeInstanceOf(GeminiRateLimited);
  });

  it('fails on other errors and on truncated answers', async () => {
    await expect(
      createGeminiClient({ ...opts, fetch: fakeFetch(500, {}).fetch })(
        's',
        'u',
      ),
    ).rejects.toThrow('500');
    const truncated = fakeFetch(200, {
      candidates: [
        { finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'x' }] } },
      ],
    });
    await expect(
      createGeminiClient({ ...opts, fetch: truncated.fetch })('s', 'u'),
    ).rejects.toThrow('stopped early');
  });
});
