import type { Kysely, Transaction, Selectable } from 'kysely';
import type { Generated, Timestamp } from '@docmost/db/types/db';
import type { DbInterface } from '@docmost/db/types/db.interface';

/**
 * Our own tables, kept out of the generated `db.d.ts` so that upstream
 * migrations never conflict with ours (see docmost-migration.md, Database
 * layer). Use `droneaidDb(db)` to get a Kysely instance that knows them.
 */
export interface DroneaidAgents {
  userId: string;
  workspaceId: string;
  spaceId: string | null;
  createdById: string | null;
  createdAt: Generated<Timestamp>;
}

export interface DroneaidAgentTokens {
  id: Generated<string>;
  agentUserId: string;
  workspaceId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdById: string | null;
  createdAt: Generated<Timestamp>;
  expiresAt: Timestamp | null;
  lastUsedAt: Timestamp | null;
  revokedAt: Timestamp | null;
}

export interface DroneaidSignupRules {
  id: Generated<string>;
  workspaceId: string;
  pattern: string;
  spaceIds: Generated<string[]>;
  spaceRole: Generated<string>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface DroneaidPageTranslations {
  id: Generated<string>;
  workspaceId: string;
  pageId: string;
  lang: string;
  sourceLang: string;
  status: Generated<string>;
  title: string | null;
  content: unknown | null;
  sourceHash: string | null;
  /** `pages.updated_at` of the version `source_hash` was made from. */
  sourceUpdatedAt: Timestamp | null;
  error: string | null;
  attempts: Generated<number>;
  availableAt: Generated<Timestamp>;
  translatedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface DroneaidTables {
  droneaidAgents: DroneaidAgents;
  droneaidAgentTokens: DroneaidAgentTokens;
  droneaidSignupRules: DroneaidSignupRules;
  droneaidPageTranslations: DroneaidPageTranslations;
}

export type DroneaidDB = Kysely<DbInterface & DroneaidTables>;
export type DroneaidTransaction = Transaction<DbInterface & DroneaidTables>;

export type DroneaidAgent = Selectable<DroneaidAgents>;
export type DroneaidAgentToken = Selectable<DroneaidAgentTokens>;
export type DroneaidSignupRule = Selectable<DroneaidSignupRules>;
export type DroneaidPageTranslation = Selectable<DroneaidPageTranslations>;

export function droneaidDb(db: Kysely<DbInterface>): DroneaidDB {
  return db as unknown as DroneaidDB;
}
