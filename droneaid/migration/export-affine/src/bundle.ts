/**
 * Bundle writer: every file is written owner-only (dirs 700, files 600) and
 * hashed as it is written, so the manifest lists exactly what is on disk.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sha256, stableJson } from './pure.ts';

export class BundleWriter {
  readonly files = new Map<string, { sha256: string; bytes: number }>();

  constructor(readonly root: string) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }

  private write(rel: string, data: Buffer | string) {
    if (rel.includes('..') || rel.startsWith('/')) throw new Error(`Bad bundle path ${rel}`);
    const path = join(this.root, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    this.files.set(rel, { sha256: sha256(buf), bytes: buf.length });
  }

  text(rel: string, content: string) {
    this.write(rel, content);
  }

  json(rel: string, value: unknown) {
    this.write(rel, stableJson(value));
  }

  copy(rel: string, source: string) {
    const data = readFileSync(source);
    this.write(rel, data);
    return this.files.get(rel)!;
  }

  /** Sorted `path -> {sha256, bytes}` of every file written so far. */
  listing() {
    return Object.fromEntries([...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  /** Move a finished `<dir>.partial` to its final name. */
  static finish(partial: string, final: string) {
    rmSync(final, { recursive: true, force: true });
    renameSync(partial, final);
    chmodSync(final, 0o700);
  }
}
