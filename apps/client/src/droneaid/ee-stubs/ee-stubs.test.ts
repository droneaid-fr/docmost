import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Runs droneaid/scripts/check-ee-stubs.sh: every @/ee import in core must be served by a stub.
describe("Enterprise stubs", () => {
  it("cover every @/ee path and name that core imports", () => {
    const script = path.resolve(__dirname, "../../../../../droneaid/scripts/check-ee-stubs.sh");
    let output = "";
    try {
      output = execFileSync(script, ["--quiet"], { encoding: "utf8", stdio: "pipe" });
    } catch (error: any) {
      throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
    expect(output).toContain("check-ee-stubs: OK");
  });
});
