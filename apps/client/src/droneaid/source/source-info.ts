// AGPL-3.0 §13: every page type offers the Corresponding Source of the running build.
// DRONEAID_SOURCE_COMMIT is baked in by vite.config.ts from the SOURCE_COMMIT build env
// (Docker build arg); it is "" in dev and tests, which then link the branch instead.
declare const DRONEAID_SOURCE_COMMIT: string | undefined;

export const SOURCE_REPO_URL = "https://github.com/droneaid-fr/docmost";
export const SOURCE_BRANCH = "droneaid";

export const SOURCE_COMMIT: string =
  typeof DRONEAID_SOURCE_COMMIT === "string" ? DRONEAID_SOURCE_COMMIT : "";

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

export function sourceCodeUrl(commit: string = SOURCE_COMMIT): string {
  const ref = COMMIT_RE.test(commit) ? commit : SOURCE_BRANCH;
  return `${SOURCE_REPO_URL}/tree/${ref}`;
}

/** First 7 hex digits of the baked commit, or "" when none was baked in. */
export function shortCommit(commit: string = SOURCE_COMMIT): string {
  return COMMIT_RE.test(commit) ? commit.slice(0, 7) : "";
}
