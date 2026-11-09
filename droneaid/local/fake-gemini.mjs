// Fake Gemini `generateContent` for the local verification stack only.
// It does not translate: it returns every Markdown block unchanged with a
// " [fake-<lang>]" tag appended, so the translation job, the language menu and
// `?lang=` can be checked without a real key. Structure (block count, headings,
// ⟦n⟧ placeholders, links) is kept, so the worker's checks pass.
import { createServer } from 'node:http';

const TAGS = {
  English: 'en', French: 'fr', Spanish: 'es', Portuguese: 'pt',
  German: 'de', Polish: 'pl', Dutch: 'nl',
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const system = body.systemInstruction?.parts?.[0]?.text ?? '';
    const user = body.contents?.[0]?.parts?.[0]?.text ?? '';
    const to = / to (\w+)\./.exec(system)?.[1] ?? '';
    const tag = TAGS[to] ?? 'xx';
    const text = user
      .trim()
      .split(/\n[ \t]*\n+/)
      .map((block) => `${block} [fake-${tag}]`)
      .join('\n\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
    }));
  });
}).listen(8080, '0.0.0.0');
