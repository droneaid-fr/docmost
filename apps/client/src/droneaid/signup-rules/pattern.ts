/**
 * Live preview of what a signup-rule pattern admits. Mirrors `describePattern`
 * in `apps/server/src/droneaid/signup-rules/signup-rules.matcher.ts`; the server
 * enforces the same rules on save, so a mismatch here can only make the form
 * stricter or laxer than the server, never weaken signup.
 */

export type PatternKind = "address" | "domain" | "wildcard";

export type PatternProblem =
  | "empty"
  | "whitespace"
  | "address_wildcard"
  | "address_incomplete"
  | "wildcard_no_domain"
  | "misplaced_wildcard";

export type PatternDescription =
  | { valid: true; kind: PatternKind; value: string }
  | { valid: false; problem: PatternProblem };

export function describePattern(pattern: string): PatternDescription {
  const p = (pattern ?? "").trim().toLowerCase();
  if (!p) return { valid: false, problem: "empty" };
  if (/\s/.test(p)) return { valid: false, problem: "whitespace" };

  if (p.includes("@")) {
    if (p.includes("*")) return { valid: false, problem: "address_wildcard" };
    const at = p.lastIndexOf("@");
    if (at === 0 || at === p.length - 1) {
      return { valid: false, problem: "address_incomplete" };
    }
    return { valid: true, kind: "address", value: p };
  }

  if (p.startsWith("*.")) {
    const base = p.slice(2);
    if (!base) return { valid: false, problem: "wildcard_no_domain" };
    if (base.includes("*") || base.startsWith(".") || base.endsWith(".")) {
      return { valid: false, problem: "misplaced_wildcard" };
    }
    return { valid: true, kind: "wildcard", value: base };
  }

  if (p.includes("*") || p.startsWith(".") || p.endsWith(".")) {
    return { valid: false, problem: "misplaced_wildcard" };
  }
  return { valid: true, kind: "domain", value: p };
}

/** Index of the first rule that must block saving, or -1. */
export function firstInvalidRule(rules: { pattern: string }[]): number {
  return rules.findIndex((r) => !describePattern(r.pattern).valid);
}
