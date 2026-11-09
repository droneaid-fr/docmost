/**
 * Integration test of the DroneAid translation module against a running
 * server (real Postgres, Redis, BullMQ, share pages) with a fake Gemini.
 * The test serves the fake Gemini itself on 127.0.0.1:8295. Start the
 * server of the step with, in `.env`:
 *
 *   TRANSLATE_ENABLED=true
 *   GEMINI_API_KEY=fake-key
 *   TRANSLATE_GEMINI_BASE_URL=http://127.0.0.1:8295/v1beta/models
 *   TRANSLATE_REFRESH_QUIET_MINUTES=0.1
 *
 * then:
 *
 *   DRONEAID_E2E_URL=http://localhost:3500 \
 *   DRONEAID_E2E_EMAIL=admin@example.com DRONEAID_E2E_PASSWORD=... \
 *   pnpm test:e2e -- droneaid-translate
 *
 * Skipped when DRONEAID_E2E_URL is not set. Flow: publish -> choose
 * languages -> the job translates -> `?lang=` serves the translation ->
 * an edit takes it offline at once and it comes back translated anew after
 * the quiet period -> Update re-translates -> unpublishing deletes the
 * translations.
 */
import { createServer, Server } from 'node:http';

const BASE = process.env.DRONEAID_E2E_URL;
const describeIf = BASE ? describe : describe.skip;
const API = `${BASE}/api`;
const RUN = Date.now().toString(36);
const FAKE_PORT = 8295;

jest.setTimeout(240_000);

const LANG_TAG: Record<string, string> = {
  French: 'fr',
  German: 'de',
  English: 'en',
};

/** Fake Gemini: "alpha" -> "alpha-<lang>"; keeps every structure intact. */
function startFakeGemini(calls: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const system: string = body.systemInstruction?.parts?.[0]?.text ?? '';
      const user: string = body.contents?.[0]?.parts?.[0]?.text ?? '';
      const to = /to (\w+)\./.exec(system)?.[1] ?? 'X';
      const tag = LANG_TAG[to] ?? 'xx';
      calls.push(`${req.url} ${tag}`);
      const text = user.replace(/\balpha\b(?!-)/g, `alpha-${tag}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            { finishReason: 'STOP', content: { parts: [{ text }] } },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(FAKE_PORT, '127.0.0.1', () => resolve(server)),
  );
}

async function login(): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DRONEAID_E2E_EMAIL,
      password: process.env.DRONEAID_E2E_PASSWORD,
    }),
  });
  const match = /authToken=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!match) throw new Error(`login failed: ${res.status}`);
  return match[1];
}

async function api(token: string | null, path: string, body: unknown = {}) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, message: json.message };
}

async function until<T>(
  what: string,
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (Date.now() < deadline) {
    last = await probe();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

const text = (node: any): string =>
  node?.type === 'text' ? node.text : (node?.content ?? []).map(text).join(' ');

describeIf('DroneAid translation (integration, fake Gemini)', () => {
  let admin: string;
  let fake: Server;
  const calls: string[] = [];
  let pageId: string;
  let shareId: string;

  const state = () => api(admin, 'droneaid/translate/page', { pageId });
  const allReady = (r: any) =>
    r.data?.translations?.length === 2 &&
    r.data.translations.every((t: any) => t.status === 'ready');

  beforeAll(async () => {
    fake = await startFakeGemini(calls);
    admin = await login();
    const spaces = await api(admin, 'spaces', {});
    const general = spaces.data.items.find((s: any) => s.slug === 'general');
    const page = await api(admin, 'pages/create', {
      spaceId: general.id,
      title: `alpha page ${RUN}`,
      format: 'markdown',
      content: [
        '## alpha heading',
        '',
        'An alpha paragraph with a [link](https://example.org/alpha-target).',
        '',
        '- alpha item',
        '',
        '| alpha | b |',
        '| --- | --- |',
        '| c | alpha |',
        '',
        '$$',
        'E=mc^2',
        '$$',
      ].join('\n'),
    });
    expect(page.status).toBe(200);
    pageId = page.data.id;
  });

  afterAll(async () => {
    await new Promise((r) => fake?.close(r));
  });

  it('offers no translation controls on a private page', async () => {
    const r = await state();
    expect(r.data.enabled).toBe(true);
    expect(r.data.published).toBe(false);
    const set = await api(admin, 'droneaid/translate/page/set', {
      pageId,
      sourceLang: 'en',
      languages: ['fr'],
    });
    expect(set.status).toBe(400);
  });

  it('publish -> choose languages -> the job translates both', async () => {
    const share = await api(admin, 'shares/create', {
      pageId,
      includeSubPages: false,
    });
    expect(share.status).toBe(200);
    shareId = share.data.id;

    const set = await api(admin, 'droneaid/translate/page/set', {
      pageId,
      sourceLang: 'en',
      languages: ['fr', 'de', 'fr'],
    });
    expect(set.status).toBe(200);
    expect(set.data.translations.map((t: any) => t.lang)).toEqual(['de', 'fr']);

    const ready = await until('translations ready', state, allReady);
    expect(ready.data.translations.every((t: any) => !t.outOfDate)).toBe(true);
    expect(calls.some((c) => c.endsWith(' fr'))).toBe(true);
    expect(calls.some((c) => c.endsWith(' de'))).toBe(true);
  });

  it('?lang= serves the translation to an anonymous reader; unknown falls back', async () => {
    const fr = await api(null, 'droneaid/translate/shared', {
      pageId,
      lang: 'fr',
    });
    expect(fr.status).toBe(200);
    expect(fr.data.sourceLang).toBe('en');
    expect(fr.data.languages).toEqual(['de', 'fr']);
    expect(fr.data.translation.title).toBe(`alpha-fr page ${RUN}`);
    const body = text(fr.data.translation.content);
    expect(body).toContain('alpha-fr heading');
    expect(body).toContain('alpha-fr item');
    expect(body).not.toMatch(/\balpha\b(?!-)/);
    const types = JSON.stringify(fr.data.translation.content);
    expect(types).toContain('"table"');
    expect(types).toContain('"mathBlock"');
    expect(types).toContain('https://example.org/alpha-target');

    for (const lang of ['xx', 'es', undefined]) {
      const r = await api(null, 'droneaid/translate/shared', { pageId, lang });
      expect(r.status).toBe(200);
      expect(r.data.translation).toBeNull();
    }

    // The original share data is untouched.
    const original = await api(null, 'shares/page-info', { pageId });
    expect(original.data.page.title).toBe(`alpha page ${RUN}`);
  });

  it('a reader without the right to share cannot change languages', async () => {
    const anonymous = await api(null, 'droneaid/translate/page/set', {
      pageId,
      sourceLang: 'en',
      languages: ['fr'],
    });
    expect(anonymous.status).toBe(401);
  });

  const sharedFr = () =>
    api(null, 'droneaid/translate/shared', { pageId, lang: 'fr' });

  it('an edit takes the translation offline at once; it returns translated anew after the quiet period', async () => {
    const update = await api(admin, 'pages/update', {
      pageId,
      format: 'markdown',
      operation: 'append',
      content: 'A quiet alpha sentence.',
    });
    expect(update.status).toBe(200);
    // As soon as the edit is saved, readers get the original.
    const offline = await until('out of date', state, (r: any) =>
      r.data?.translations?.every((t: any) => t.outOfDate),
    );
    expect(offline.data.refreshQuietMinutes).toBeGreaterThan(0);
    const shown = await sharedFr();
    expect(shown.data.translation).toBeNull();
    expect(shown.data.languages).toEqual([]);
    // No Update pressed: the job translates it again on its own.
    const back = await until(
      'served again',
      sharedFr,
      (r: any) => r.data?.translation !== null,
      120_000,
    );
    expect(text(back.data.translation.content)).toContain(
      'A quiet alpha-fr sentence.',
    );
    expect(back.data.languages).toEqual(['de', 'fr']);
  });

  it('an edit flags "out of date"; Update re-translates', async () => {
    const update = await api(admin, 'pages/update', {
      pageId,
      format: 'markdown',
      operation: 'append',
      content: 'A new alpha sentence.',
    });
    expect(update.status).toBe(200);
    await until('out of date', state, (r: any) =>
      r.data?.translations?.every((t: any) => t.outOfDate),
    );

    const callsBefore = calls.length;
    const refresh = await api(admin, 'droneaid/translate/page/update', {
      pageId,
    });
    expect(refresh.status).toBe(200);
    const after = await until(
      'retranslated',
      state,
      (r: any) =>
        allReady(r) && r.data.translations.every((t: any) => !t.outOfDate),
    );
    expect(after.data.translations).toHaveLength(2);
    expect(calls.length).toBeGreaterThan(callsBefore);
    const fr = await api(null, 'droneaid/translate/shared', {
      pageId,
      lang: 'fr',
    });
    expect(text(fr.data.translation.content)).toContain(
      'A new alpha-fr sentence.',
    );
  });

  it('unpublishing deletes the translations', async () => {
    const del = await api(admin, 'shares/delete', { shareId });
    expect(del.status).toBe(200);
    const gone = await api(null, 'droneaid/translate/shared', {
      pageId,
      lang: 'fr',
    });
    expect(gone.status).toBe(404);
    await until(
      'translations deleted',
      state,
      (r: any) => r.data?.translations?.length === 0,
      60_000,
    );
  });
});
