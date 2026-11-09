import {
  describePattern,
  isAllowedByRules,
  matchesPattern,
  resolveSpaceGrants,
  validateRules,
} from './signup-rules.matcher';

const rule = (pattern: string, spaceIds: string[] = [], spaceRole = 'writer') => ({
  pattern,
  spaceIds,
  spaceRole,
});

describe('matchesPattern', () => {
  it.each([
    // [email, pattern, expected]
    ['a@example.com', 'example.com', true],
    ['A@EXAMPLE.COM', ' Example.com ', true],
    ['a@sub.example.com', 'example.com', false],
    ['a@notexample.com', 'example.com', false],
    ['a@example.com', '*.example.com', true],
    ['a@sub.example.com', '*.example.com', true],
    ['a@deep.sub.example.com', '*.example.com', true],
    ['a@notexample.com', '*.example.com', false],
    ['a@example.com.evil.org', '*.example.com', false],
    ['partner@example.com', 'partner@example.com', true],
    ['Partner@Example.com', 'partner@example.com', true],
    ['notpartner@example.com', 'partner@example.com', false],
    ['other@example.com', 'partner@example.com', false],
    ['weird@local@example.com', 'weird@local@example.com', true],
    ['weird@local@example.com', 'local@example.com', false],
    ['weird@local@example.com', 'example.com', true],
    ['not-an-email', 'example.com', false],
    ['a@example.com', '', false],
    ['a@example.com', '*.', false],
    ['a@example.com', '*@example.com', false],
    ['a@example.com', 'ex*ample.com', false],
  ])('%s vs %s -> %s', (email, pattern, expected) => {
    expect(matchesPattern(email, pattern)).toBe(expected);
  });
});

describe('describePattern / validation', () => {
  it.each([
    ['example.com', { valid: true, kind: 'domain', value: 'example.com' }],
    ['*.Example.com', { valid: true, kind: 'wildcard', value: 'example.com' }],
    ['Bob@Example.com', { valid: true, kind: 'address', value: 'bob@example.com' }],
  ])('%s is valid', (pattern, expected) => {
    expect(describePattern(pattern)).toEqual(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['*.', 'wildcard_no_domain'],
    ['*@example.com', 'address_wildcard'],
    ['bob@*.example.com', 'address_wildcard'],
    ['ex*ample.com', 'misplaced_wildcard'],
    ['*', 'misplaced_wildcard'],
    ['*example.com', 'misplaced_wildcard'],
    ['*.*.example.com', 'misplaced_wildcard'],
    ['example.com.', 'misplaced_wildcard'],
    ['@example.com', 'address_incomplete'],
    ['bob@', 'address_incomplete'],
    ['exa mple.com', 'whitespace'],
  ])('%j is refused (%s)', (pattern, problem) => {
    expect(describePattern(pattern)).toEqual({ valid: false, problem });
  });

  it('validateRules reports the first unusable rule', () => {
    expect(validateRules([rule('example.com'), rule('*@x.org')])).toEqual({
      index: 1,
      pattern: '*@x.org',
      problem: 'address_wildcard',
    });
    expect(validateRules([rule('example.com'), rule('a@b.org')])).toBeNull();
    expect(validateRules([])).toBeNull();
  });
});

describe('isAllowedByRules', () => {
  it('admits nobody when there are no rules', () => {
    expect(isAllowedByRules('a@example.com', [])).toBe(false);
  });

  it('admits when any rule matches, even one that grants nothing', () => {
    const rules = [rule('other.org'), rule('*.example.com')];
    expect(isAllowedByRules('a@x.example.com', rules)).toBe(true);
    expect(isAllowedByRules('a@elsewhere.net', rules)).toBe(false);
  });

  it('ignores never-matching rules instead of throwing', () => {
    expect(isAllowedByRules('a@example.com', [rule('*@example.com')])).toBe(false);
  });
});

describe('resolveSpaceGrants', () => {
  it('collects grants from every matching rule only', () => {
    const grants = resolveSpaceGrants('a@example.com', [
      rule('example.com', ['s1'], 'reader'),
      rule('*.example.com', ['s2'], 'writer'),
      rule('other.org', ['s3'], 'admin'),
    ]);
    expect(grants).toEqual([
      { spaceId: 's1', role: 'reader' },
      { spaceId: 's2', role: 'writer' },
    ]);
  });

  it('the strongest role wins when rules grant the same space', () => {
    const rules = [
      rule('example.com', ['s1', 's2'], 'reader'),
      rule('boss@example.com', ['s1'], 'admin'),
      rule('*.example.com', ['s2'], 'writer'),
    ];
    expect(resolveSpaceGrants('boss@example.com', rules)).toEqual([
      { spaceId: 's1', role: 'admin' },
      { spaceId: 's2', role: 'writer' },
    ]);
    // Order does not matter: a weaker role later never lowers a stronger one.
    expect(resolveSpaceGrants('boss@example.com', [...rules].reverse())).toEqual(
      expect.arrayContaining([
        { spaceId: 's1', role: 'admin' },
        { spaceId: 's2', role: 'writer' },
      ]),
    );
  });

  it('an unknown role degrades to reader', () => {
    expect(
      resolveSpaceGrants('a@example.com', [rule('example.com', ['s1'], 'owner')]),
    ).toEqual([{ spaceId: 's1', role: 'reader' }]);
  });

  it('no match, no grants', () => {
    expect(resolveSpaceGrants('a@x.org', [rule('example.com', ['s1'])])).toEqual([]);
  });
});
