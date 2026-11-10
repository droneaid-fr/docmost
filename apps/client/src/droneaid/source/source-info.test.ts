import { describe, expect, it } from "vitest";
import {
  SOURCE_COMMIT,
  shortCommit,
  sourceCodeUrl,
} from "./source-info.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("source-info", () => {
  it("has no baked commit outside a release build", () => {
    expect(SOURCE_COMMIT).toBe("");
  });

  it("links the exact commit when one is baked in", () => {
    expect(sourceCodeUrl(SHA)).toBe(
      `https://github.com/droneaid-fr/docmost/tree/${SHA}`,
    );
    expect(shortCommit(SHA)).toBe("0123456");
  });

  it("falls back to the droneaid branch without a valid commit", () => {
    for (const bad of ["", "main", "abc", "zzzzzzzz", `${SHA}0`]) {
      expect(sourceCodeUrl(bad)).toBe(
        "https://github.com/droneaid-fr/docmost/tree/droneaid",
      );
      expect(shortCommit(bad)).toBe("");
    }
  });
});
