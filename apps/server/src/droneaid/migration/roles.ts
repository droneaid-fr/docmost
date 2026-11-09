import type {
  Bundle,
  BundleGrant,
  BundleUser,
  LoadedWorkspace,
  SignupAllowEntry,
} from './bundle';

/**
 * Who becomes what (pure). Decisions of the S6b brief:
 *  - every human AFFiNE user is recreated (no password; Google sign-in links
 *    by email); placeholders (`registered=false`) only if they hold a
 *    membership or a grant; agent accounts are not users;
 *  - Docmost workspace role: `ownerEmail` -> owner, AFFiNE instance admins
 *    -> admin, everyone else -> member;
 *  - space role from the AFFiNE workspace role: owner/admin -> admin,
 *    member (Collaborator) -> writer, external -> reader; only active
 *    memberships;
 *  - per-doc grants are not reproduced, only reported for review.
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type SpaceRoleName = 'admin' | 'writer' | 'reader';

export type UserPlan = {
  user: BundleUser;
  workspaceRole: WorkspaceRole;
};

export type SkippedUser = { email: string; reason: string };

export function isAgentUser(user: BundleUser): boolean {
  return !!user.agentOfWorkspaceId;
}

export function planUsers(
  bundle: Pick<Bundle, 'users' | 'workspaces'>,
  ownerEmail: string,
): { users: UserPlan[]; skipped: SkippedUser[] } {
  const granted = new Set<string>();
  for (const ws of bundle.workspaces) {
    for (const grant of ws.grants) {
      if (grant.principal?.userId) granted.add(grant.principal.userId);
    }
  }
  const owner = ownerEmail.trim().toLowerCase();
  const users: UserPlan[] = [];
  const skipped: SkippedUser[] = [];
  for (const user of [...bundle.users].sort((a, b) => a.email.localeCompare(b.email))) {
    if (isAgentUser(user)) {
      skipped.push({ email: user.email, reason: 'agent account (not a user)' });
      continue;
    }
    if (!user.registered && !user.memberships.length && !granted.has(user.id)) {
      skipped.push({
        email: user.email,
        reason: 'placeholder (registered=false) without membership or grant',
      });
      continue;
    }
    const email = user.email.toLowerCase();
    users.push({
      user,
      workspaceRole: email === owner ? 'owner' : user.admin ? 'admin' : 'member',
    });
  }
  if (!users.some((u) => u.workspaceRole === 'owner')) {
    throw new Error(`Owner ${ownerEmail} is not among the bundle's users.`);
  }
  return { users, skipped };
}

export function spaceRoleFor(affineRole: string): SpaceRoleName | null {
  switch ((affineRole ?? '').toLowerCase()) {
    case 'owner':
    case 'admin':
      return 'admin';
    case 'member':
    case 'collaborator':
      return 'writer';
    case 'external':
      return 'reader';
    default:
      return null;
  }
}

export type SpaceMemberPlan = { email: string; role: SpaceRoleName; affineRole: string };
export type SkippedMember = { workspace: string; email: string; role: string; state: string; reason: string };

export function planSpaceMembers(ws: LoadedWorkspace): {
  members: SpaceMemberPlan[];
  skipped: SkippedMember[];
} {
  const members: SpaceMemberPlan[] = [];
  const skipped: SkippedMember[] = [];
  for (const m of ws.workspace.members) {
    const base = {
      workspace: ws.workspace.name,
      email: m.email,
      role: m.role,
      state: m.state,
    };
    if (m.agent) {
      skipped.push({ ...base, reason: 'agent (handled by the agent setup)' });
      continue;
    }
    if (m.state !== 'active') {
      skipped.push({ ...base, reason: 'membership not active' });
      continue;
    }
    const role = spaceRoleFor(m.role);
    if (!role) {
      skipped.push({ ...base, reason: 'unknown AFFiNE role' });
      continue;
    }
    members.push({ email: m.email.toLowerCase(), role, affineRole: m.role });
  }
  return { members, skipped };
}

// ------------------------------------------------------------ grant review

/** What a grant or role allows on one doc: 1 read, 2 edit. */
function docLevel(role: string | null | undefined): number {
  switch ((role ?? '').toLowerCase()) {
    case 'owner':
    case 'manager':
    case 'editor':
    case 'admin':
    case 'writer':
      return 2;
    case 'commenter':
    case 'reader':
      return 1;
    default:
      return 0;
  }
}

export type GrantReview = {
  workspace: string;
  docId: string;
  docTitle: string | null;
  email: string | null;
  grantRole: string;
  spaceRole: SpaceRoleName | null;
  effect: 'widened' | 'narrowed' | 'same';
  note: string;
};

/**
 * Human per-doc grants compared with the space role the person gets.
 * `widened`: the grant gave more than the space role does (or the person is
 * no member at all), so in Docmost they lose it. `narrowed`: the doc had a
 * lower default role for members than the workspace, so in Docmost members
 * get more. `same` grants need no review (owner grants of members, ...).
 */
export function reviewGrants(ws: LoadedWorkspace): GrantReview[] {
  const roles = new Map(
    planSpaceMembers(ws).members.map((m) => [m.email, m.role] as const),
  );
  const titles = new Map(ws.docs.map((d) => [d.docId, d.title] as const));
  const docIds = new Set(ws.docs.map((d) => d.docId));
  const out: GrantReview[] = [];
  const human = (g: BundleGrant) =>
    g.principalType === 'user' && !g.principal?.agent && docIds.has(g.docId);

  for (const grant of ws.grants.filter(human)) {
    const email = grant.principal.email?.toLowerCase() ?? null;
    const spaceRole = email ? (roles.get(email) ?? null) : null;
    const widened = !spaceRole || docLevel(grant.role) > docLevel(spaceRole);
    out.push({
      workspace: ws.workspace.name,
      docId: grant.docId,
      docTitle: grant.docTitle ?? titles.get(grant.docId) ?? null,
      email,
      grantRole: grant.role,
      spaceRole,
      effect: widened ? 'widened' : 'same',
      note: widened
        ? spaceRole
          ? `grant ${grant.role} > space ${spaceRole}`
          : 'not a member of the space: access lost'
        : 'covered by the space role',
    });
  }
  for (const doc of ws.docs) {
    const docDefault = doc.publish?.memberDefaultRole;
    if (!docDefault) continue;
    out.push({
      workspace: ws.workspace.name,
      docId: doc.docId,
      docTitle: doc.title,
      email: null,
      grantRole: `members: ${docDefault}`,
      spaceRole: null,
      effect: 'narrowed',
      note: `doc-level default role for members was ${docDefault} (workspace default: ${ws.workspace.sharing?.memberDefaultDocRole ?? 'unknown'}); in Docmost members get their space role`,
    });
  }
  return out;
}

/** Workspaces (other than its own) where an agent held any doc grant. */
export function agentReaderWorkspaces(
  workspaces: LoadedWorkspace[],
  agentEmail: string,
  ownWorkspaceId: string,
): { workspaceId: string; name: string; grants: number }[] {
  const email = agentEmail.toLowerCase();
  return workspaces
    .filter((ws) => ws.workspace.id !== ownWorkspaceId)
    .map((ws) => ({
      workspaceId: ws.workspace.id,
      name: ws.workspace.name,
      grants: ws.grants.filter((g) => g.principal?.email?.toLowerCase() === email)
        .length,
    }))
    .filter((w) => w.grants > 0);
}

// ------------------------------------------------------------ signup rules

export type SignupRulePlan = {
  pattern: string;
  spaceRole: SpaceRoleName;
  workspaceIds: string[];
  affineRole: string;
};

/** AFFiNE allowlist roles are the invitation roles (Collaborator, Admin, ...). */
export function planSignupRules(entries: SignupAllowEntry[]): {
  rules: SignupRulePlan[];
  skipped: { pattern: string; reason: string }[];
} {
  const rules: SignupRulePlan[] = [];
  const skipped: { pattern: string; reason: string }[] = [];
  for (const entry of entries) {
    const spaceRole = spaceRoleFor(entry.role);
    if (!spaceRole || !entry.pattern?.trim()) {
      skipped.push({ pattern: entry.pattern, reason: `unknown role ${entry.role}` });
      continue;
    }
    rules.push({
      pattern: entry.pattern.trim().toLowerCase(),
      spaceRole,
      workspaceIds: [...new Set(entry.workspaces ?? [])],
      affineRole: entry.role,
    });
  }
  return { rules, skipped };
}
