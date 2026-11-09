// Core expects: useEntitlements() -> { data } copied into entitlementAtom; never any data here.
import type { Entitlements } from "./entitlement-atom";

export function useEntitlements(): { data: Entitlements | undefined } {
  return { data: undefined };
}
