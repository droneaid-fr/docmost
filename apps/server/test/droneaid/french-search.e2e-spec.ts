/**
 * Page search in French (migration 20261109T180000-droneaid-french-search).
 * Runs the real SearchService query against the step's Postgres (DATABASE_URL
 * from the root .env, migrations applied). All rows live in one transaction
 * that is rolled back.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { SearchService } from '../../src/core/search/search.service';

// The repos are stubbed below; mocking their modules keeps their ESM-only
// imports (uuid) out of the e2e transform.
jest.mock('@docmost/db/repos/page/page.repo', () => ({ PageRepo: class {} }));
jest.mock('@docmost/db/repos/space/space-member.repo', () => ({ SpaceMemberRepo: class {} }));
jest.mock('@docmost/db/repos/share/share.repo', () => ({ ShareRepo: class {} }));
jest.mock('@docmost/db/repos/page/page-permission.repo', () => ({ PagePermissionRepo: class {} }));

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

class Rollback extends Error {}

const DOCS = [
  { title: 'Opportunité de financement', text: 'Une subvention européenne pour les structures associatives.' },
  { title: 'Calendrier', text: 'Le prochain événement a lieu à Lyon avec des bénévoles.' },
  { title: 'Sécurité', text: 'Les vols dangereux sont interdits; règles nationales.' },
  { title: 'Workshop notes', text: 'Drone pilots training workshops in English.' },
];

describe('French page search (droneaid)', () => {
  let db: Kysely<any>;

  beforeAll(() => {
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: postgres(process.env.DATABASE_URL, { max: 2 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Seeds DOCS in a throwaway space, runs fn, rolls everything back. */
  async function withSeed(fn: (search: (q: string) => Promise<any[]>) => Promise<void>) {
    await db
      .transaction()
      .execute(async (trx) => {
        const ws = await trx
          .insertInto('workspaces')
          .values({ name: 'fr-search-test' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const space = await trx
          .insertInto('spaces')
          .values({ name: 'FR', slug: `fr-${Date.now()}`, workspaceId: ws.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('pages')
          .values(
            DOCS.map((d, i) => ({
              title: d.title,
              textContent: d.text,
              slugId: `frs${Date.now()}${i}`,
              spaceId: space.id,
              workspaceId: ws.id,
            })),
          )
          .execute();

        const service = new SearchService(
          trx as any,
          { withSpace: () => sql`null`.as('space') } as any,
          {} as any,
          {} as any,
          { filterAccessiblePageIds: async ({ pageIds }: any) => pageIds } as any,
        );
        const search = async (query: string) =>
          (
            await service.searchPage(
              { query, spaceId: space.id } as any,
              { userId: 'u', workspaceId: ws.id },
            )
          ).items;
        await fn(search);
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  const titles = (items: any[]) => items.map((i) => i.title);

  it.each([
    ['opportunités', 'Opportunité de financement'], // plural → singular
    ['subventions européennes', 'Opportunité de financement'],
    ['evenement', 'Calendrier'], // no accents → accented text
    ['événements', 'Calendrier'],
    ['bénévole', 'Calendrier'],
    ['dangereuse', 'Sécurité'], // feminine → masculine
    ['nationaux', 'Sécurité'], // nationales
    ['associatif', 'Opportunité de financement'], // associatives
    ['securite', 'Sécurité'], // title, unaccented
    ['pilot workshop', 'Workshop notes'], // English content still found
  ])('"%s" finds "%s"', async (query, expected) => {
    await withSeed(async (search) => {
      expect(titles(await search(query))).toContain(expected);
    });
  });

  it('ignores French stop words', async () => {
    await withSeed(async (search) => {
      expect(await search('des')).toEqual([]);
    });
  });

  it('highlights the matched words in the excerpt', async () => {
    await withSeed(async (search) => {
      const [hit] = await search('subventions');
      expect(hit.highlight).toMatch(/<b>subvention<\/b>/i);
    });
  });
});
