import { describe, expect, it } from "vitest";
import { describePattern, firstInvalidRule } from "./pattern";

describe("describePattern", () => {
  it.each([
    ["example.com", { valid: true, kind: "domain", value: "example.com" }],
    [" *.Example.com ", { valid: true, kind: "wildcard", value: "example.com" }],
    ["Bob@Example.com", { valid: true, kind: "address", value: "bob@example.com" }],
  ])("%j is valid", (pattern, expected) => {
    expect(describePattern(pattern)).toEqual(expected);
  });

  it.each([
    ["", "empty"],
    ["*.", "wildcard_no_domain"],
    ["*@example.com", "address_wildcard"],
    ["ex*ample.com", "misplaced_wildcard"],
    ["*.*.example.com", "misplaced_wildcard"],
    ["@example.com", "address_incomplete"],
    ["a b.com", "whitespace"],
  ])("%j can never match (%s)", (pattern, problem) => {
    expect(describePattern(pattern)).toEqual({ valid: false, problem });
  });
});

describe("firstInvalidRule", () => {
  it("finds the first unusable rule", () => {
    expect(firstInvalidRule([{ pattern: "a.org" }, { pattern: "" }])).toBe(1);
    expect(firstInvalidRule([{ pattern: "a.org" }])).toBe(-1);
  });
});
