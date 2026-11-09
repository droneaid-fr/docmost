/**
 * E2E: Google sign-in against a mock OIDC provider (ghcr.io/navikt/mock-oauth2-server).
 *
 * Runs against a live dev server, not an in-process app. Prerequisites (S2 port block):
 *   docker run -d --name docmost-s2-oidc -p 127.0.0.1:8292:8080 ghcr.io/navikt/mock-oauth2-server:2.1.10
 *   .env: GOOGLE_CLIENT_ID=docmost-test GOOGLE_CLIENT_SECRET=docmost-test-secret
 *         GOOGLE_OIDC_ISSUER=http://localhost:8292/default
 *   cd apps/server && pnpm start:dev
 * Then: pnpm test:e2e -- droneaid/google-auth
 *
 * Env overrides: E2E_BASE_URL (default http://localhost:3200), E2E_DATABASE_URL
 * (default: DATABASE_URL from the root .env). The test seeds rows directly in the DB
 * (signup rules with run-unique patterns, spaces, invitations) and restores the
 * workspace domain list and the signup switch afterwards.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const postgres = require('postgres') as typeof import('postgres');

function rootEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const file = path.resolve(__dirname, '../../../../.env');
  if (!fs.existsSync(file)) return undefined;
  const line = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.E2E_DATABASE_URL ?? rootEnv('DATABASE_URL');
const RUN = randomUUID().slice(0, 8);
const ALLOWED = `allowed-${RUN}.test`;
const OTHER = `legacy-${RUN}.test`;

jest.setTimeout(30_000);

type Claims = Record<string, unknown>;
interface FlowResult {
  location: string;
  authToken?: string;
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [k, ...v] = pair.split('=');
    if (k.trim() === name && v.join('=')) return v.join('=');
  }
  return undefined;
}

let flowCount = 0;

/** Start -> mock IdP login form -> our callback. Returns where the callback sends the browser. */
async function googleFlow(
  sub: string,
  claims: Claims,
  opts: { tamperState?: boolean } = {},
): Promise<FlowResult> {
  // A fresh client IP per flow keeps reruns under the auth throttler (10/min per IP);
  // the server trusts X-Forwarded-For (trustProxy).
  flowCount += 1;
  const ip = `10.42.${Math.floor(Math.random() * 250)}.${flowCount}`;
  const start = await fetch(`${BASE}/api/droneaid/auth/google`, {
    headers: { 'x-forwarded-for': ip },
    redirect: 'manual',
  });
  expect(start.status).toBe(302);
  const stateCookie = cookieValue(start, 'droneaid_google_oauth');
  expect(stateCookie).toBeDefined();
  const authorizeUrl = start.headers.get('location');
  expect(authorizeUrl).toContain('code_challenge_method=S256');
  expect(authorizeUrl).toContain('state=');

  const login = await fetch(authorizeUrl, {
    method: 'POST',
    body: new URLSearchParams({ username: sub, claims: JSON.stringify(claims) }),
    redirect: 'manual',
  });
  expect(login.status).toBe(302);
  let callbackUrl = login.headers.get('location');
  expect(callbackUrl).toContain('/api/droneaid/auth/google/callback');
  if (opts.tamperState) {
    callbackUrl = callbackUrl.replace(/state=[^&]+/, 'state=forged');
  }

  const cb = await fetch(callbackUrl, {
    headers: {
      cookie: `droneaid_google_oauth=${stateCookie}`,
      'x-forwarded-for': ip,
    },
    redirect: 'manual',
  });
  expect(cb.status).toBe(302);
  return {
    location: cb.headers.get('location'),
    authToken: cookieValue(cb, 'authToken'),
  };
}

async function me(authToken: string) {
  const res = await fetch(`${BASE}/api/users/me`, {
    method: 'POST',
    headers: { cookie: `authToken=${authToken}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.user;
}

const verified = (email: string, name = 'Test User') => ({
  email,
  email_verified: true,
  name,
});

describe('Google sign-in (mock OIDC)', () => {
  const sql = postgres(DB_URL, { max: 2 });
  let workspaceId: string;
  let defaultRole: string;
  let providerId: string;
  let saved: { emailDomains: string[]; allowSignup: boolean };
  const ruleIds: string[] = [];
  const spaceIds: string[] = [];

  async function insertRule(pattern: string, spaces: string[] = [], role = 'writer') {
    const [r] = await sql`
      insert into droneaid_signup_rules (workspace_id, pattern, space_ids, space_role)
      values (${workspaceId}, ${pattern}, ${spaces}::uuid[], ${role})
      returning id`;
    ruleIds.push(r.id);
    return r.id as string;
  }

  async function insertSpace(name: string) {
    const [sp] = await sql`
      insert into spaces (name, slug, workspace_id, visibility)
      values (${name}, ${`${name}-${RUN}`.toLowerCase()}, ${workspaceId}, 'private')
      returning id`;
    spaceIds.push(sp.id);
    return sp.id as string;
  }

  async function spaceRole(userId: string, spaceId: string) {
    const rows = await sql`
      select role from space_members where user_id = ${userId} and space_id = ${spaceId}`;
    return rows[0]?.role ?? null;
  }

  async function insertUser(email: string, extra: Record<string, unknown> = {}) {
    const [u] = await sql`
      insert into users ${sql({
        email,
        name: email.split('@')[0],
        workspace_id: workspaceId,
        role: 'member',
        ...extra,
      })}
      returning id`;
    return u.id as string;
  }

  async function setAllowSignup(v: boolean) {
    await sql`update auth_providers set allow_signup = ${v} where id = ${providerId}`;
  }

  beforeAll(async () => {
    const cfg = await fetch(`${BASE}/api/droneaid/auth/google/config`);
    expect((await cfg.json()).data).toEqual({ enabled: true });

    const [ws] = await sql`select id, email_domains, default_role from workspaces limit 1`;
    expect(ws).toBeDefined();
    workspaceId = ws.id;
    defaultRole = ws.defaultRole ?? ws.default_role;

    // The module creates the provider row on first use; create it here if absent, using
    // the same lookup (type google, not deleted) so the server finds this row.
    let [provider] = await sql`
      select id, allow_signup from auth_providers
      where workspace_id = ${workspaceId} and type = 'google' and deleted_at is null
      order by created_at asc limit 1`;
    if (!provider) {
      [provider] = await sql`
        insert into auth_providers (name, type, workspace_id, is_enabled, allow_signup)
        values ('Google', 'google', ${workspaceId}, false, false)
        returning id, allow_signup`;
    }
    providerId = provider.id;
    saved = {
      emailDomains: ws.email_domains ?? [],
      allowSignup: provider.allow_signup,
    };

    // Rules, not core email_domains, decide Google signup. Clear the domain list so
    // the invite cases are not restricted by it (restored afterwards).
    await sql`update workspaces set email_domains = ${[]} where id = ${workspaceId}`;
    await insertRule(ALLOWED);
    await setAllowSignup(true);
  });

  afterAll(async () => {
    if (ruleIds.length) await sql`delete from droneaid_signup_rules where id in ${sql(ruleIds)}`;
    if (spaceIds.length) {
      await sql`delete from space_members where space_id in ${sql(spaceIds)}`;
      await sql`delete from spaces where id in ${sql(spaceIds)}`;
    }
    await sql`update workspaces set email_domains = ${saved.emailDomains} where id = ${workspaceId}`;
    await setAllowSignup(saved.allowSignup);
    await sql.end();
  });

  it('existing user: links the Google account and signs in', async () => {
    const email = `alice@${ALLOWED}`;
    const userId = await insertUser(email);
    const sub = `sub-alice-${RUN}`;

    const r = await googleFlow(sub, verified('Alice@' + ALLOWED.toUpperCase()));
    expect(r.location).toBe(`${BASE}/home`);
    expect(r.authToken).toBeDefined();
    expect((await me(r.authToken)).id).toBe(userId);

    const links = await sql`
      select provider_user_id from auth_accounts
      where user_id = ${userId} and auth_provider_id = ${providerId}`;
    expect(links.map((l) => l.providerUserId ?? l.provider_user_id)).toEqual([sub]);

    // Second sign-in goes through the stored link, even if the Google email changed.
    const again = await googleFlow(sub, verified(`alice.renamed@gmail.com`));
    expect((await me(again.authToken)).id).toBe(userId);
  });

  it('new user matching a rule: signs up with the default role and group', async () => {
    const email = `newbie@${ALLOWED}`;
    const r = await googleFlow(`sub-newbie-${RUN}`, verified(email, 'New Bie'));
    expect(r.location).toBe(`${BASE}/home`);
    const user = await me(r.authToken);
    expect(user.email).toBe(email);
    expect(user.name).toBe('New Bie');
    expect(user.role).toBe(defaultRole);

    const groups = await sql`
      select g.is_default from group_users gu join groups g on g.id = gu.group_id
      where gu.user_id = ${user.id}`;
    expect(groups.some((g) => g.isDefault ?? g.is_default)).toBe(true);

    const [row] = await sql`select email_verified_at from users where id = ${user.id}`;
    expect(row.emailVerifiedAt ?? row.email_verified_at).not.toBeNull();
  });

  it('new user matching no rule: refused, no user created', async () => {
    const email = `mallory@gmail-${RUN}.test`;
    const r = await googleFlow(`sub-mallory-${RUN}`, verified(email));
    expect(r.location).toBe(`${BASE}/login?google_error=domain_not_allowed`);
    expect(r.authToken).toBeUndefined();
    const rows = await sql`select id from users where lower(email) = ${email}`;
    expect(rows).toHaveLength(0);
  });

  it('email_verified=false: refused', async () => {
    const email = `unverified@${ALLOWED}`;
    await insertUser(email);
    const r = await googleFlow(`sub-unverified-${RUN}`, {
      email,
      email_verified: false,
    });
    expect(r.location).toBe(`${BASE}/login?google_error=email_not_verified`);
    expect(r.authToken).toBeUndefined();
  });

  it('existing user outside every rule: still signs in', async () => {
    const email = `legacy@${OTHER}`;
    const userId = await insertUser(email);
    const r = await googleFlow(`sub-legacy-${RUN}`, verified(email));
    expect(r.location).toBe(`${BASE}/home`);
    expect((await me(r.authToken)).id).toBe(userId);
  });

  it('deactivated user: refused', async () => {
    const email = `gone@${ALLOWED}`;
    await insertUser(email, { deactivated_at: new Date() });
    const r = await googleFlow(`sub-gone-${RUN}`, verified(email));
    expect(r.location).toBe(`${BASE}/login?google_error=account_disabled`);
    expect(r.authToken).toBeUndefined();
  });

  it('signup switched off: an unknown allowed email is refused', async () => {
    await setAllowSignup(false);
    try {
      const r = await googleFlow(`sub-late-${RUN}`, verified(`late@${ALLOWED}`));
      expect(r.location).toBe(`${BASE}/login?google_error=signup_disabled`);
    } finally {
      await setAllowSignup(true);
    }
  });

  it('forged state: refused', async () => {
    const r = await googleFlow(`sub-x-${RUN}`, verified(`alice@${ALLOWED}`), {
      tamperState: true,
    });
    expect(r.location).toBe(`${BASE}/login?google_error=state_mismatch`);
    expect(r.authToken).toBeUndefined();
  });
  describe('signup rules and invitations', () => {
    it('allowlisted account lands in its space with the granted role', async () => {
      const space = await insertSpace('Ops');
      const domain = `ops-${RUN}.test`;
      await insertRule(`*.${domain}`, [space], 'reader');
      const r = await googleFlow(`sub-ops-${RUN}`, verified(`pilot@team.${domain}`));
      expect(r.location).toBe(`${BASE}/home`);
      const user = await me(r.authToken);
      expect(await spaceRole(user.id, space)).toBe('reader');
    });

    it('two rules granting the same space: the stronger role wins', async () => {
      const space = await insertSpace('Board');
      const domain = `board-${RUN}.test`;
      await insertRule(domain, [space], 'reader');
      await insertRule(`chair@${domain}`, [space], 'admin');
      await insertRule(`*.${domain}`, [space], 'writer');
      const r = await googleFlow(`sub-chair-${RUN}`, verified(`chair@${domain}`));
      const user = await me(r.authToken);
      expect(await spaceRole(user.id, space)).toBe('admin');
    });

    it('a deleted space in a rule is skipped without failing signup', async () => {
      const kept = await insertSpace('Kept');
      const gone = randomUUID();
      const domain = `gone-${RUN}.test`;
      await insertRule(domain, [gone, kept], 'writer');
      const r = await googleFlow(`sub-gonespace-${RUN}`, verified(`x@${domain}`));
      expect(r.location).toBe(`${BASE}/home`);
      const user = await me(r.authToken);
      expect(await spaceRole(user.id, kept)).toBe('writer');
      expect(await spaceRole(user.id, gone)).toBeNull();
    });

    it('non-allowlisted account is refused even with signup on', async () => {
      const email = `nobody@nowhere-${RUN}.test`;
      const r = await googleFlow(`sub-nobody-${RUN}`, verified(email));
      expect(r.location).toBe(`${BASE}/login?google_error=domain_not_allowed`);
      expect(await sql`select id from users where lower(email) = ${email}`).toHaveLength(0);
    });

    it('pending invitation: admitted without a rule, joins via the invite', async () => {
      await setAllowSignup(false);
      try {
        const [inviter] = await sql`
          select id from users where workspace_id = ${workspaceId} and role in ('owner','admin')
          order by created_at limit 1`;
        const [group] = await sql`
          insert into groups (name, workspace_id, is_default)
          values (${`Invited-${RUN}`}, ${workspaceId}, false) returning id`;
        const space = await insertSpace('Invited');
        await sql`insert into space_members (space_id, group_id, role)
                  values (${space}, ${group.id}, 'writer')`;
        const email = `guest@invited-${RUN}.test`;
        const [inv] = await sql`
          insert into workspace_invitations
            (email, role, token, group_ids, invited_by_id, workspace_id, expires_at)
          values (${email}, 'admin', ${'tok-' + RUN}, ${[group.id]}::uuid[],
                  ${inviter?.id ?? null}, ${workspaceId}, now() + interval '1 day')
          returning id`;

        const r = await googleFlow(`sub-guest-${RUN}`, verified(email.toUpperCase()));
        expect(r.location).toBe(`${BASE}/home`);
        const user = await me(r.authToken);
        expect(user.email).toBe(email);
        expect(user.role).toBe('admin');
        const groups = await sql`select group_id from group_users where user_id = ${user.id}`;
        expect(groups.map((g) => g.groupId ?? g.group_id)).toContain(group.id);
        expect(await sql`select id from workspace_invitations where id = ${inv.id}`).toHaveLength(0);

        await sql`delete from group_users where group_id = ${group.id}`;
        await sql`delete from space_members where group_id = ${group.id}`;
        await sql`delete from groups where id = ${group.id}`;
      } finally {
        await setAllowSignup(true);
      }
    });

    it('expired invitation does not admit', async () => {
      await setAllowSignup(false);
      try {
        const email = `late@expired-${RUN}.test`;
        await sql`
          insert into workspace_invitations (email, role, token, workspace_id, expires_at)
          values (${email}, 'member', ${'tok2-' + RUN}, ${workspaceId}, now() - interval '1 minute')`;
        const r = await googleFlow(`sub-expired-${RUN}`, verified(email));
        expect(r.location).toBe(`${BASE}/login?google_error=signup_disabled`);
      } finally {
        await setAllowSignup(true);
      }
    });

    it('invite acceptance through core also applies rule grants', async () => {
      const space = await insertSpace('Accept');
      const domain = `accept-${RUN}.test`;
      await insertRule(domain, [space], 'writer');
      const email = `invitee@${domain}`;
      const token = `tok3-${RUN}`;
      const [inv] = await sql`
        insert into workspace_invitations (email, role, token, workspace_id, expires_at)
        values (${email}, 'member', ${token}, ${workspaceId}, now() + interval '1 day')
        returning id`;
      const res = await fetch(`${BASE}/api/workspace/invites/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invitationId: inv.id,
          token,
          name: 'Invitee',
          password: 'correct-horse-battery',
        }),
      });
      expect(res.status).toBe(200);
      const [user] = await sql`select id from users where email = ${email}`;
      expect(await spaceRole(user.id, space)).toBe('writer');
    });
  });
});
