/**
 * Pure decision logic for "Continue with Google".
 *
 * Given the verified ID-token claims and what the database already holds, decide
 * whether to sign an existing user in, link Google to an existing user first,
 * create a new user, or refuse. No I/O here, so every branch is unit-tested.
 */

export type GoogleRefusalCode =
  | 'email_not_verified'
  | 'missing_email'
  | 'account_disabled'
  | 'account_conflict'
  | 'signup_disabled'
  | 'domain_not_allowed';

export interface GoogleClaims {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

export interface DecisionUser {
  id: string;
  email: string;
  deactivatedAt?: Date | null;
  deletedAt?: Date | null;
  /** An MCP agent account (`droneaid_agents`): never signs in with Google. */
  isAgent?: boolean;
}

export interface DecisionInput {
  claims: GoogleClaims;
  /** User already linked to this Google `sub` (via auth_accounts), if any. */
  linkedUser?: DecisionUser | null;
  /** User whose email matches the Google email (case-insensitive), if any. */
  userByEmail?: DecisionUser | null;
  /** Google `sub` already linked to `userByEmail`, if that user has a Google link. */
  userByEmailLinkedSub?: string | null;
  /**
   * "Allow new accounts via Google for matching addresses"
   * (`auth_providers.allow_signup` of our Google provider row).
   */
  allowSignup: boolean;
  /** Whether a signup rule (`droneaid_signup_rules`) matches the Google email. */
  allowedByRules: boolean;
  /** A pending (unexpired) workspace invitation for the Google email, if any. */
  pendingInvitation?: { id: string } | null;
  /**
   * `workspaces.email_domains`; empty or null means every domain is allowed. Read
   * only for invitees, because core invitation acceptance enforces it.
   */
  emailDomains?: string[] | null;
}

export type Decision =
  | { action: 'login'; userId: string }
  | { action: 'link_and_login'; userId: string }
  | { action: 'signup'; email: string; name?: string }
  | {
      action: 'signup_invited';
      email: string;
      name?: string;
      invitationId: string;
    }
  | { action: 'refuse'; code: GoogleRefusalCode };

/**
 * Agent accounts authenticate with their agent token only. They are refused
 * like a disabled account, so Google can neither sign in as an agent nor link
 * a Google account to one (whatever its email).
 */
function isDisabled(user: DecisionUser): boolean {
  return !!(user.deactivatedAt || user.deletedAt || user.isAgent);
}

/** Google sends a boolean; some providers send the string "true". */
export function isEmailVerified(claims: GoogleClaims): boolean {
  return claims.email_verified === true || claims.email_verified === 'true';
}

/**
 * Same rule as core `validateAllowedEmail` (`core/auth/auth.util.ts`), as a predicate:
 * an empty or missing domain list allows every domain.
 */
export function isEmailDomainAllowed(
  email: string,
  emailDomains?: string[] | null,
): boolean {
  if (!emailDomains || emailDomains.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return emailDomains.map((d) => d.toLowerCase()).includes(domain);
}

export function decideGoogleSignIn(input: DecisionInput): Decision {
  const { claims } = input;

  if (!isEmailVerified(claims)) {
    return { action: 'refuse', code: 'email_not_verified' };
  }

  const email = claims.email?.trim();
  if (!email || !email.includes('@')) {
    return { action: 'refuse', code: 'missing_email' };
  }

  // 1. Already linked: the Google account identifies the user, whatever its email is now.
  if (input.linkedUser) {
    if (isDisabled(input.linkedUser)) {
      return { action: 'refuse', code: 'account_disabled' };
    }
    return { action: 'login', userId: input.linkedUser.id };
  }

  // 2. Existing user with this email: link it. Neither the rules nor the domain
  //    list apply here, so existing accounts are never locked out.
  if (input.userByEmail) {
    if (isDisabled(input.userByEmail)) {
      return { action: 'refuse', code: 'account_disabled' };
    }
    if (
      input.userByEmailLinkedSub &&
      input.userByEmailLinkedSub !== claims.sub
    ) {
      // The user is already linked to a different Google account.
      return { action: 'refuse', code: 'account_conflict' };
    }
    return { action: 'link_and_login', userId: input.userByEmail.id };
  }

  // 3. Unknown email with a pending invitation: join through the invitation, as
  //    accepting it would. The invitation is the admin's consent, so neither the
  //    Google switch nor the rules apply; core's domain list does, as in core.
  if (input.pendingInvitation) {
    if (!isEmailDomainAllowed(email, input.emailDomains)) {
      return { action: 'refuse', code: 'domain_not_allowed' };
    }
    return {
      action: 'signup_invited',
      email: email.toLowerCase(),
      name: claims.name,
      invitationId: input.pendingInvitation.id,
    };
  }

  // 4. Unknown email: signup, only if Google signup is on and a rule matches.
  if (!input.allowSignup) {
    return { action: 'refuse', code: 'signup_disabled' };
  }
  if (!input.allowedByRules) {
    return { action: 'refuse', code: 'domain_not_allowed' };
  }
  return { action: 'signup', email: email.toLowerCase(), name: claims.name };
}
