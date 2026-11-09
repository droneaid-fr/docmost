/**
 * Signup allowlist: pattern matching, validation and space-grant resolution.
 * Pure functions, no I/O. The semantics follow the AFFiNE allowlist
 * (`core/auth/email-allowlist.ts` in our AFFiNE fork):
 *
 *   - Matching is case-insensitive and ignores surrounding whitespace.
 *   - A pattern containing `@` is a full address and matches that address alone.
 *   - `example.com` matches that domain and nothing else (no subdomains).
 *   - `*.example.com` matches the apex `example.com` and every subdomain beneath
 *     it, at any depth.
 *   - Where several matching rules grant the same space, the strongest role wins.
 *
 * One difference: an empty rule list admits nobody. The "Allow new accounts via
 * Google" switch is what opens or closes signup; the rules say who it is open to.
 *
 * The client keeps a copy of `describePattern` for its live preview
 * (`apps/client/src/droneaid/signup-rules/pattern.ts`); the two must agree.
 */

export const SPACE_GRANT_ROLES = ['reader', 'writer', 'admin'] as const;
export type SpaceGrantRole = (typeof SPACE_GRANT_ROLES)[number];

const ROLE_STRENGTH: Record<SpaceGrantRole, number> = {
  reader: 1,
  writer: 2,
  admin: 3,
};

export interface SignupRuleLike {
  pattern: string;
  spaceIds: readonly string[];
  spaceRole: string;
}

export interface SpaceGrant {
  spaceId: string;
  role: SpaceGrantRole;
}

export type PatternKind = 'address' | 'domain' | 'wildcard';

export type PatternProblem =
  | 'empty'
  | 'whitespace'
  | 'address_wildcard'
  | 'address_incomplete'
  | 'wildcard_no_domain'
  | 'misplaced_wildcard';

export type PatternDescription =
  | { valid: true; kind: PatternKind; value: string }
  | { valid: false; problem: PatternProblem };

export function normalizePattern(pattern: string): string {
  return (pattern ?? '').trim().toLowerCase();
}

export function isSpaceGrantRole(role: unknown): role is SpaceGrantRole {
  return SPACE_GRANT_ROLES.includes(role as SpaceGrantRole);
}

/**
 * What a pattern admits, or why it can never match an address. A pattern that
 * can never match is refused on save: it would silently admit nobody.
 */
export function describePattern(pattern: string): PatternDescription {
  const p = normalizePattern(pattern);
  if (!p) return { valid: false, problem: 'empty' };
  if (/\s/.test(p)) return { valid: false, problem: 'whitespace' };

  if (p.includes('@')) {
    if (p.includes('*')) return { valid: false, problem: 'address_wildcard' };
    const at = p.lastIndexOf('@');
    if (at === 0 || at === p.length - 1) {
      return { valid: false, problem: 'address_incomplete' };
    }
    return { valid: true, kind: 'address', value: p };
  }

  if (p.startsWith('*.')) {
    const base = p.slice(2);
    if (!base) return { valid: false, problem: 'wildcard_no_domain' };
    if (base.includes('*') || base.startsWith('.') || base.endsWith('.')) {
      return { valid: false, problem: 'misplaced_wildcard' };
    }
    return { valid: true, kind: 'wildcard', value: base };
  }

  if (p.includes('*') || p.startsWith('.') || p.endsWith('.')) {
    return { valid: false, problem: 'misplaced_wildcard' };
  }
  return { valid: true, kind: 'domain', value: p };
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

export function matchesPattern(email: string, pattern: string): boolean {
  const address = normalizePattern(email);
  const d = describePattern(pattern);
  if ('problem' in d || !address) return false;

  // Compared whole, so `a@b@example.com` only ever matches itself.
  if (d.kind === 'address') return address === d.value;

  const domain = emailDomain(address);
  if (!domain) return false;
  if (d.kind === 'wildcard') {
    return domain === d.value || domain.endsWith(`.${d.value}`);
  }
  return domain === d.value;
}

export function matchingRules<T extends SignupRuleLike>(
  email: string,
  rules: readonly T[],
): T[] {
  return rules.filter((rule) => matchesPattern(email, rule.pattern));
}

/** Whether any rule admits `email`. An empty list admits nobody. */
export function isAllowedByRules(
  email: string,
  rules: readonly SignupRuleLike[],
): boolean {
  return matchingRules(email, rules).length > 0;
}

/**
 * The spaces a new `email` account joins, deduplicated. Where several matching
 * rules grant the same space, the strongest role wins. An unknown role in the
 * data degrades to `reader` rather than throwing at signup time.
 */
export function resolveSpaceGrants(
  email: string,
  rules: readonly SignupRuleLike[],
): SpaceGrant[] {
  const strongest = new Map<string, SpaceGrantRole>();
  for (const rule of matchingRules(email, rules)) {
    const role: SpaceGrantRole = isSpaceGrantRole(rule.spaceRole)
      ? rule.spaceRole
      : 'reader';
    for (const spaceId of rule.spaceIds) {
      const current = strongest.get(spaceId);
      if (!current || ROLE_STRENGTH[role] > ROLE_STRENGTH[current]) {
        strongest.set(spaceId, role);
      }
    }
  }
  return [...strongest].map(([spaceId, role]) => ({ spaceId, role }));
}

/** The first problem that must block saving a rule list, or null. */
export function validateRules(
  rules: readonly Pick<SignupRuleLike, 'pattern'>[],
): { index: number; pattern: string; problem: PatternProblem } | null {
  for (let i = 0; i < rules.length; i++) {
    const d = describePattern(rules[i].pattern);
    if ('problem' in d) {
      return { index: i, pattern: rules[i].pattern ?? '', problem: d.problem };
    }
  }
  return null;
}
