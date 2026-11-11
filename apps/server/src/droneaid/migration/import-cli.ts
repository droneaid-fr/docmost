import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppModule } from '../../app.module';
import { MigrationModule } from './migration.module';
import { AffineImporter, ImportOptions } from './importer.service';
import { reportMarkdown } from './report';
import { ImportVerifier, verifyMarkdown } from './verifier.service';
import { caddySnippet } from './url-map';
import { parseExcludeList } from './bundle';

/**
 * AFFiNE bundle -> Docmost, as a one-shot Nest app (the whole server module
 * graph, so every write goes through core services; HTTP is initialised but
 * never listens). Usage (built server):
 *
 *   node apps/server/dist/droneaid/migration/import-cli.js \
 *     --bundle <migration-bundle-dir> --out <report-dir> [--skip-trashed] \
 *     [--owner-email filipp@droneaid.fr] [--workspace-name DroneAid] \
 *     [--agent-name "DroneAid France agent"] [--agent-workspace "DroneAid France"] [--no-agent]
 *     [--exclude-workspaces "Demo Workspace"]   AFFiNE workspaces left out (names or ids, comma
 *                                               separated; default "Demo Workspace"; `none` = all)
 *     [--verify | --verify-only]   check the result against the bundle (exit 2 on a failed check)
 *
 * Reads the root `.env` like the server (DATABASE_URL, REDIS_URL, storage).
 */

@Module({ imports: [AppModule, MigrationModule] })
class ImportCliModule {}

type Args = ImportOptions & { outDir: string; verify: 'after' | 'only' | null };

export function parseArgs(argv: string[], now = new Date()): Args {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const known = new Set([
    '--bundle', '--out', '--owner-email', '--workspace-name', '--agent-name',
    '--agent-workspace', '--skip-trashed', '--no-agent', '--verify', '--verify-only',
    '--exclude-workspaces',
  ]);
  for (const a of argv) {
    if (a.startsWith('--') && !known.has(a)) throw new Error(`Unknown option ${a}`);
  }
  const bundleDir = value('--bundle');
  if (!bundleDir) throw new Error('--bundle <dir> is required');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return {
    bundleDir: path.resolve(bundleDir),
    outDir: path.resolve(
      value('--out') ?? path.join(path.dirname(path.resolve(bundleDir)), `import-docmost-${stamp}`),
    ),
    ownerEmail: value('--owner-email') ?? 'filipp@droneaid.fr',
    workspaceName: value('--workspace-name') ?? 'DroneAid',
    skipTrashed: argv.includes('--skip-trashed'),
    excludeWorkspaces: parseExcludeList(value('--exclude-workspaces')),
    verify: argv.includes('--verify-only') ? 'only' : argv.includes('--verify') ? 'after' : null,
    agent: argv.includes('--no-agent')
      ? null
      : {
          name: value('--agent-name') ?? 'DroneAid France agent',
          workspaceName: value('--agent-workspace') ?? 'DroneAid France',
        },
  };
}

async function writeOutputs(outDir: string, report: any) {
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  await fs.chmod(outDir, 0o700);
  const write = (name: string, text: string) =>
    fs.writeFile(path.join(outDir, name), text, { mode: 0o600 });
  await write('import-report.json', JSON.stringify(report, null, 2) + '\n');
  await write('import-report.md', reportMarkdown(report));
  await write(
    'url-map.json',
    JSON.stringify(
      {
        hosts: ['base.droneaid.fr', 'base.drone-aid.fr'],
        fallback: '/home',
        mapped: report.urlMap.mapped,
        unmapped: report.urlMap.unmapped,
      },
      null,
      2,
    ) + '\n',
  );
  await write('redirects.caddy', caddySnippet(report.urlMap.mapped));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.create<NestFastifyApplication>(
    ImportCliModule,
    new FastifyAdapter(),
    { logger: ['error', 'warn'] },
  );
  // Same prefix as main.ts. Without it a root controller's GET '' lands on '/',
  // which StaticModule also registers when the client is built (as in the
  // image): Fastify then refuses the duplicate route and the CLI dies.
  app.setGlobalPrefix('api');
  await app.init();
  let code = 0;
  try {
    if (args.verify !== 'only') {
      const report = await app.get(AffineImporter).run(args);
      await writeOutputs(args.outDir, report);
      console.log(
        `Import done in ${report.timingsMs.total} ms: ${JSON.stringify(report.created)}; ` +
          `skipped existing ${JSON.stringify(report.skippedExisting)}. Reports in ${args.outDir}`,
      );
    }
    if (args.verify) {
      const check = await app.get(ImportVerifier).verify(args.bundleDir, args.excludeWorkspaces);
      await fs.mkdir(args.outDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(args.outDir, 'verify.json'), JSON.stringify(check, null, 2) + '\n', { mode: 0o600 });
      await fs.writeFile(path.join(args.outDir, 'verify.md'), verifyMarkdown(check), { mode: 0o600 });
      console.log(verifyMarkdown(check));
      if (!check.ok) code = 2;
    }
  } catch (err) {
    console.error('Import failed:', err);
    code = 1;
  } finally {
    await app.close().catch(() => undefined);
  }
  process.exit(code);
}

if (require.main === module) {
  void main();
}
