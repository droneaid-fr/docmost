// Core expects: entitlementAtom holding { tier, features } read by the settings sidebar; always empty here.
import { atom } from "jotai";

export type Entitlements = { tier?: string; features?: string[] };

export const entitlementAtom = atom<Entitlements>({ features: [] });
