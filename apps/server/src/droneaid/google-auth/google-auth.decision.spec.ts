import {
  decideGoogleSignIn,
  DecisionInput,
  isEmailDomainAllowed,
  isEmailVerified,
} from './google-auth.decision';

const claims = (over: Partial<DecisionInput['claims']> = {}) => ({
  sub: 'google-sub-1',
  email: 'Alice@DroneAid.fr',
  email_verified: true,
  name: 'Alice',
  ...over,
});

const user = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'alice@droneaid.fr',
  deactivatedAt: null,
  deletedAt: null,
  ...over,
});

const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  claims: claims(),
  linkedUser: null,
  userByEmail: null,
  userByEmailLinkedSub: null,
  allowSignup: true,
  allowedByRules: true,
  pendingInvitation: null,
  emailDomains: [],
  ...over,
});

describe('decideGoogleSignIn', () => {
  describe('email verification', () => {
    it('refuses email_verified=false even for a linked user', () => {
      expect(
        decideGoogleSignIn(
          base({
            claims: claims({ email_verified: false }),
            linkedUser: user(),
          }),
        ),
      ).toEqual({ action: 'refuse', code: 'email_not_verified' });
    });

    it('refuses a missing email_verified claim', () => {
      expect(
        decideGoogleSignIn(
          base({ claims: claims({ email_verified: undefined }) }),
        ),
      ).toEqual({ action: 'refuse', code: 'email_not_verified' });
    });

    it('refuses a missing email', () => {
      expect(
        decideGoogleSignIn(base({ claims: claims({ email: undefined }) })),
      ).toEqual({ action: 'refuse', code: 'missing_email' });
    });
  });

  describe('already linked account', () => {
    it('logs the linked user in', () => {
      expect(decideGoogleSignIn(base({ linkedUser: user() }))).toEqual({
        action: 'login',
        userId: 'user-1',
      });
    });

    it('wins over the email lookup (Google email changed)', () => {
      expect(
        decideGoogleSignIn(
          base({
            claims: claims({ email: 'new@gmail.com' }),
            linkedUser: user(),
            allowSignup: false,
          }),
        ),
      ).toEqual({ action: 'login', userId: 'user-1' });
    });

    it('refuses a deactivated linked user', () => {
      expect(
        decideGoogleSignIn(
          base({ linkedUser: user({ deactivatedAt: new Date() }) }),
        ),
      ).toEqual({ action: 'refuse', code: 'account_disabled' });
    });

    it('refuses a deleted linked user', () => {
      expect(
        decideGoogleSignIn(base({ linkedUser: user({ deletedAt: new Date() }) })),
      ).toEqual({ action: 'refuse', code: 'account_disabled' });
    });
  });

  describe('existing user found by email', () => {
    it('links and logs in', () => {
      expect(decideGoogleSignIn(base({ userByEmail: user() }))).toEqual({
        action: 'link_and_login',
        userId: 'user-1',
      });
    });

    it('is never locked out by the domain rule', () => {
      expect(
        decideGoogleSignIn(
          base({
            claims: claims({ email: 'bob@gmail.com' }),
            userByEmail: user({ email: 'bob@gmail.com' }),
            emailDomains: ['droneaid.fr'],
            allowedByRules: false,
            allowSignup: false,
          }),
        ),
      ).toEqual({ action: 'link_and_login', userId: 'user-1' });
    });

    it('re-links when the stored sub is the same', () => {
      expect(
        decideGoogleSignIn(
          base({ userByEmail: user(), userByEmailLinkedSub: 'google-sub-1' }),
        ),
      ).toEqual({ action: 'link_and_login', userId: 'user-1' });
    });

    it('refuses when the user is linked to a different Google account', () => {
      expect(
        decideGoogleSignIn(
          base({ userByEmail: user(), userByEmailLinkedSub: 'other-sub' }),
        ),
      ).toEqual({ action: 'refuse', code: 'account_conflict' });
    });

    it('refuses a deactivated user', () => {
      expect(
        decideGoogleSignIn(
          base({ userByEmail: user({ deactivatedAt: new Date() }) }),
        ),
      ).toEqual({ action: 'refuse', code: 'account_disabled' });
    });
  });

  describe('agent accounts', () => {
    it('never signs in as an agent linked to this Google account', () => {
      expect(
        decideGoogleSignIn(base({ linkedUser: user({ isAgent: true }) })),
      ).toEqual({ action: 'refuse', code: 'account_disabled' });
    });

    it('never links Google to an agent found by email', () => {
      expect(
        decideGoogleSignIn(
          base({ userByEmail: user({ isAgent: true }), allowSignup: true }),
        ),
      ).toEqual({ action: 'refuse', code: 'account_disabled' });
    });
  });

  describe('unknown email', () => {
    it('signs up when a rule matches, lower-casing the email', () => {
      expect(decideGoogleSignIn(base())).toEqual({
        action: 'signup',
        email: 'alice@droneaid.fr',
        name: 'Alice',
      });
    });

    it('refuses when no rule matches', () => {
      expect(decideGoogleSignIn(base({ allowedByRules: false }))).toEqual({
        action: 'refuse',
        code: 'domain_not_allowed',
      });
    });

    it('ignores core email_domains on the rule path', () => {
      expect(
        decideGoogleSignIn(base({ emailDomains: ['other.org'] })),
      ).toMatchObject({ action: 'signup' });
    });

    it('refuses when signup is disabled, even when a rule matches', () => {
      expect(decideGoogleSignIn(base({ allowSignup: false }))).toEqual({
        action: 'refuse',
        code: 'signup_disabled',
      });
    });
  });

  describe('unknown email with a pending invitation', () => {
    const invited = (over: Partial<DecisionInput> = {}) =>
      base({
        pendingInvitation: { id: 'inv-1' },
        allowedByRules: false,
        allowSignup: false,
        ...over,
      });

    it('joins through the invitation with no rule and signup off', () => {
      expect(decideGoogleSignIn(invited())).toEqual({
        action: 'signup_invited',
        email: 'alice@droneaid.fr',
        name: 'Alice',
        invitationId: 'inv-1',
      });
    });

    it('applies core email_domains, as invitation acceptance does', () => {
      expect(
        decideGoogleSignIn(invited({ emailDomains: ['other.org'] })),
      ).toEqual({ action: 'refuse', code: 'domain_not_allowed' });
      expect(
        decideGoogleSignIn(invited({ emailDomains: ['droneaid.fr'] })),
      ).toMatchObject({ action: 'signup_invited' });
    });

    it('an existing account still just signs in', () => {
      expect(decideGoogleSignIn(invited({ userByEmail: user() }))).toEqual({
        action: 'link_and_login',
        userId: 'user-1',
      });
    });
  });
});

describe('isEmailDomainAllowed', () => {
  it('matches case-insensitively', () => {
    expect(isEmailDomainAllowed('a@DroneAid.FR', ['droneaid.fr'])).toBe(true);
  });
  it('does not match subdomains', () => {
    expect(isEmailDomainAllowed('a@mail.droneaid.fr', ['droneaid.fr'])).toBe(
      false,
    );
  });
  it('allows everything for null or empty lists', () => {
    expect(isEmailDomainAllowed('a@x.io', null)).toBe(true);
    expect(isEmailDomainAllowed('a@x.io', [])).toBe(true);
  });
});

describe('isEmailVerified', () => {
  it('accepts true and "true" only', () => {
    expect(isEmailVerified({ sub: 's', email_verified: true })).toBe(true);
    expect(isEmailVerified({ sub: 's', email_verified: 'true' })).toBe(true);
    expect(isEmailVerified({ sub: 's', email_verified: 'false' })).toBe(false);
    expect(isEmailVerified({ sub: 's' })).toBe(false);
  });
});
