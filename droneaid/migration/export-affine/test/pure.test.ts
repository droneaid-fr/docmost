import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  affineLinkTargets,
  blobFileName,
  blockMarker,
  commentText,
  compareCounts,
  handlingOf,
  imageMarkdown,
  inlineLatexToText,
  latexMarkdown,
  markerValue,
  needsSentinel,
  oldHostLinks,
  oldUrlInventory,
  parseBlockMarker,
  redactAppConfigs,
  replaceSentinels,
  stableJson,
  tidyMarkdown,
} from '../src/pure.ts';

test('stableJson sorts keys, handles bigint/bytes/dates, drops undefined', () => {
  const a = stableJson({ b: 1n, a: { d: undefined, c: new Uint8Array([1, 2]) }, e: new Date(0), f: NaN });
  assert.equal(
    a,
    '{\n  "a": {\n    "c": {\n      "$bytes": "AQI="\n    }\n  },\n  "b": 1,\n  "e": "1970-01-01T00:00:00.000Z",\n  "f": null\n}\n'
  );
  assert.equal(stableJson({ x: 2n ** 70n }), '{\n  "x": "1180591620717411303424"\n}\n');
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
});

test('handlingOf classifies flavours, canvas wins', () => {
  assert.equal(handlingOf('affine:paragraph'), 'markdown');
  assert.equal(handlingOf('affine:note'), 'structural');
  assert.equal(handlingOf('affine:image'), 'image');
  assert.equal(handlingOf('affine:image', true), 'canvas');
  assert.equal(handlingOf('affine:latex'), 'latex');
  assert.equal(handlingOf('affine:database'), 'database');
  assert.equal(handlingOf('affine:embed-youtube'), 'marker');
  assert.equal(handlingOf('affine:frame'), 'canvas');
  assert.equal(needsSentinel('marker'), true);
  assert.equal(needsSentinel('markdown'), false);
  assert.equal(needsSentinel('canvas'), false);
});

test('block markers are one line, ordered, and round-trip', () => {
  const marker = blockMarker('abc_-1', 'affine:bookmark', {
    url: 'https://x.test/a?b="c"--d',
    title: 'Two\nlines 100%',
    blob: undefined,
  });
  assert.equal(
    marker,
    '<!-- affine-block id=abc_-1 flavour=affine:bookmark title="Two%0Alines 100%25" url="https://x.test/a?b=%22c%22%2D%2Dd" -->'
  );
  assert.ok(!marker.slice(4, -3).includes('--'));
  assert.deepEqual(parseBlockMarker(marker), {
    id: 'abc_-1',
    flavour: 'affine:bookmark',
    attrs: { title: 'Two\nlines 100%', url: 'https://x.test/a?b="c"--d' },
  });
  assert.equal(parseBlockMarker('<!-- database id=x -->'), null);
  assert.equal(markerValue('a--b'), 'a%2D%2Db');
});

test('image and latex markdown', () => {
  assert.equal(imageMarkdown('K=', ' a [b]\n c '), '![a b c](blob://K=)');
  assert.equal(imageMarkdown('K='), '![](blob://K=)');
  assert.equal(latexMarkdown(' x^2 \n'), '$$\nx^2\n$$');
});

test('replaceSentinels keeps indentation and reports unknown sentinels', () => {
  const md = 'a\n    AFFINEMCPBLOCK61X\nAFFINEMCPBLOCK62X  \nAFFINEMCPBLOCK63X\nb';
  const out = replaceSentinels(md, new Map([['AFFINEMCPBLOCK61X', '$$\nx\n$$'], ['AFFINEMCPBLOCK62X', 'B']]));
  assert.equal(out.markdown, 'a\n    $$\n    x\n    $$\nB\nAFFINEMCPBLOCK63X\nb');
  assert.deepEqual(out.missing, ['AFFINEMCPBLOCK63X']);
  // A sentinel inside a sentence is not a line of its own and stays.
  assert.equal(replaceSentinels('x AFFINEMCPBLOCK61X', new Map([['AFFINEMCPBLOCK61X', 'Y']])).markdown, 'x AFFINEMCPBLOCK61X');
});

test('inlineLatexToText rewrites only latex ops and keeps other marks', () => {
  const { delta, count } = inlineLatexToText([
    { insert: 'solve ' },
    { insert: ' ', attributes: { latex: 'x^2' } },
    { insert: ' ', attributes: { latex: 'y', bold: true } },
    { insert: 'bold', attributes: { bold: true } },
  ]);
  assert.equal(count, 2);
  assert.deepEqual(delta, [
    { insert: 'solve ' },
    { insert: '$x^2$' },
    { insert: '$y$', attributes: { bold: true } },
    { insert: 'bold', attributes: { bold: true } },
  ]);
});

test('tidyMarkdown trims trailing spaces and long blank runs', () => {
  assert.equal(tidyMarkdown('\n\na  \n\n\n\n\nb\n\n\n'), 'a\n\n\nb\n');
});

test('link helpers find affine:// targets and old-host links', () => {
  const md = '[A](affine://x1) [B](affine://x1) [C](affine://y-2) see https://base.drone-aid.fr/workspace/w/d?mode=page and https://example.com';
  assert.deepEqual(affineLinkTargets(md), ['x1', 'y-2']);
  assert.deepEqual(oldHostLinks(md, ['base.droneaid.fr', 'base.drone-aid.fr']), [
    'https://base.drone-aid.fr/workspace/w/d?mode=page',
  ]);
});

test('oldUrlInventory lists doc, legacy share, workspace, tag, collection and blob paths, sorted', () => {
  const urls = oldUrlInventory({
    workspaces: [{ id: 'W' }],
    docs: [{ workspaceId: 'W', docId: 'D', published: true }],
    collections: [{ workspaceId: 'W', id: 'C' }],
    tags: [{ workspaceId: 'W', id: 'T' }],
    blobs: [{ workspaceId: 'W', key: 'K=' }],
  });
  const paths = urls.map(u => u.path);
  assert.deepEqual(paths, [...paths].sort());
  for (const p of ['/workspace/W/D', '/share/W/D', '/workspace/W/all', '/workspace/W/collection/C', '/workspace/W/tag/T', '/api/workspaces/W/blobs/K=']) {
    assert.ok(paths.includes(p), p);
  }
  assert.equal(urls.find(u => u.path === '/workspace/W/D')?.published, true);
});

test('redactAppConfigs copies only allow-listed values', () => {
  const out = redactAppConfigs([
    { id: 'translate.gemini.apiKey', value: 'SECRET' },
    { id: 'oauth.providers.google', value: { clientSecret: 'SECRET' } },
    { id: 'auth.allowedEmailDomains', value: ['droneaid.fr'] },
    { id: 'translate.enabled', value: false },
  ]);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.deepEqual(out.map(o => o.key), ['auth.allowedEmailDomains', 'oauth.providers.google', 'translate.enabled', 'translate.gemini.apiKey']);
  assert.deepEqual(out[0], { key: 'auth.allowedEmailDomains', valueCopied: true, value: ['droneaid.fr'] });
  assert.equal(out[2].restoreNote?.includes('restored copy'), true);
});

test('blobFileName adds an extension and refuses path-like keys', () => {
  assert.equal(blobFileName('ab_-=', 'image/PNG'), 'ab_-=.png');
  assert.equal(blobFileName('ab', 'application/x-unknown'), 'ab');
  assert.throws(() => blobFileName('../x', 'image/png'));
  assert.throws(() => blobFileName('a/b', 'image/png'));
});

test('commentText flattens the stored BlockSuite snapshot', () => {
  const content = {
    mode: 'page',
    snapshot: {
      blocks: {
        flavour: 'affine:page',
        props: { title: { delta: [] } },
        children: [
          { flavour: 'affine:note', children: [
            { flavour: 'affine:paragraph', props: { text: { delta: [{ insert: 'Hello ' }, { insert: 'world', attributes: { bold: true } }] } } },
            { flavour: 'affine:paragraph', props: { text: { delta: [{ insert: 'Second' }] } } },
          ] },
        ],
      },
    },
  };
  assert.equal(commentText(content), 'Hello world\nSecond');
  assert.equal(commentText(null), '');
});

test('compareCounts flags differences and missing keys', () => {
  assert.deepEqual(compareCounts({ a: 1, b: 2 }, { a: 1, c: 3 }), [
    { key: 'a', expected: 1, actual: 1, ok: true },
    { key: 'b', expected: 2, actual: null, ok: false },
    { key: 'c', expected: null, actual: 3, ok: false },
  ]);
});
