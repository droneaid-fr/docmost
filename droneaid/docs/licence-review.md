# Licence-compliance review of the DroneAid Docmost fork

Reviewed 2026-11-10 against `droneaid` @ `16fab6ad` (`git diff main...droneaid`, `main` = upstream
`adb2ba50`, v0.97.0+). Independent review; the reviewer did not open any file under
`apps/client/src/ee`, `apps/server/src/ee`, `packages/ee` or `packages/base-formula` except
their `LICENSE` files.

> **Not legal advice.** I am not a lawyer. Each finding is tagged **[fact]** (checked in the
> repo, the image or a primary source) or **[interpretation]** (my reading of a licence text).
> Have anything marked BLOCKER or anything you plan to lean on read by someone qualified,
> ideally under French law, since the association and the service are in France.

## Verdict

**The fork is not ready to run publicly yet. One blocker remains: AGPL §13.** The service
must offer its network users the source of the exact version it runs, and today the UI offers
none. The only source-like link (Settings → version badge) points at **upstream's** release
page and labels the build "v0.97.0", as if it were unmodified Docmost. Fix this before
`base.droneaid.fr` serves the fork.

The Enterprise side is clean as far as I can verify. No commit of ours touches an EE path. The
`s9` image contains no EE path and no EE chunk. The stubs are written from core call sites.
No new third-party dependency was added. The code ported from the AFFiNE fork is Filipp's own
work, apart from three trivial lines. The remaining items are cheap housekeeping: a
modification notice, the licence and source label in the image, branding, and deleting stale
EE builds on the dev host.

| # | Severity | Finding |
|---|---|---|
| 1 | **BLOCKER** | No offer of Corresponding Source in the UI (§13); the version badge points at upstream |
| 2 | SHOULD FIX | Deployed version must be provably public: image ↔ commit, commit pushed before deploy |
| 3 | SHOULD FIX | Image's `org.opencontainers.image.source` label says `github.com/docmost/docmost`; image carries no licence text |
| 4 | SHOULD FIX | No "prominent notice" that the work is modified, with a date (§5(a)); our files state no licence or copyright holder |
| 5 | SHOULD FIX | Pre-S8 images and a stale client `dist/` with compiled EE code exist on the dev host |
| 6 | SHOULD FIX | Modified build is presented as "Docmost" (name, logo, title); DOCMOST word mark is filed |
| 7 | NOTE | Public fork still contains the EE files (369 + 25 + 1 + licence files), unchanged |
| 8 | NOTE | Stubs mirror EE module paths and export names, derived from core only; acceptable for interop |
| 9 | NOTE | Removed EE "License & Edition" page; whether it held legal notices is unknowable from the clean room |
| 10 | NOTE | AFFiNE-origin code: Filipp-authored, but sits under AFFiNE's backend licence in the AFFiNE fork |
| 11 | NOTE | Dependencies: none added; those our code uses are MIT / Apache-2.0 / CC0 / Unlicense / BSD |
| 12 | NOTE | Copyright holder of our additions (Filipp personally vs the association) is undefined |

---

## 1. What is licensed how [fact]

| Path | Licence | Evidence |
|---|---|---|
| Everything not listed below (core) | AGPL-3.0 | `LICENSE` (standard AGPL-3.0 text; GitHub detects `agpl-3.0` on `droneaid-fr/docmost`). `README.md`: "Docmost core is licensed under the open-source AGPL 3.0 license." No version-"or later" statement anywhere. |
| `apps/client/src/ee` (369 tracked files) | Docmost Enterprise License | `apps/client/src/ee/LICENSE` (first line "Files in this directory are subject to the Docmost Enterprise Edition license.", then the same text as `packages/ee/LICENSE`) |
| `apps/server/src/ee` | Docmost Enterprise License | Gitlink only (`160000 commit ab54ba07…` → private `github.com/docmost/ee`); empty in our checkout. Listed in `README.md` |
| `packages/ee` | Docmost Enterprise License | `packages/ee/LICENSE` |
| `packages/base-formula` (25 files) | Docmost Enterprise License | `packages/base-formula/LICENSE`, byte-identical to `packages/ee/LICENSE`. **Not** listed in upstream `README.md`'s EE list; only its own LICENSE says so |
| `package.json` `license` fields | none set; `apps/server/package.json` has `"license": ""` | upstream, unchanged |
| Our additions (`*/droneaid/**`, migrations, tests, locales) | **unstated** | no headers, no SPDX tags, no NOTICE (see finding 4) |

## 2. Docmost Enterprise License: what it says [fact] and how it applies [interpretation]

Quoted from `packages/ee/LICENSE`:

- Production use: "may only be used in production, if you … have agreed to … the Docmost
  Subscription Terms of Service … and otherwise have a valid Docmost Enterprise Edition
  subscription for the correct number of user seats."
- Modification: "you are free to modify this Software and publish patches … Docmost … retain all
  right, title and interest in and to all such modifications and/or patches, and all such
  modifications and/or patches may only be used … with a valid … subscription".
- Dev/test: "you may copy and modify the Software for development and testing purposes, without
  requiring a subscription."
- Everything else: "You are not granted any other rights … it is forbidden to copy, merge,
  publish, distribute, sublicense, and/or sell the Software."

How it applies to us:

- **We do not use EE code in production** [fact, see §3 below]. No subscription is needed.
- **We did not modify, move or copy EE files** [fact]: `git log main..droneaid -- <each EE dir>`
  is empty, `git diff --stat main...droneaid -- <each EE dir>` is empty, and the tracked file
  counts are identical on `main` and `droneaid` (369 / 1 gitlink / 1 / 25).
- **Keeping the files in the public fork** [interpretation]: on its face, "forbidden to …
  publish, distribute" covers a public copy. In practice the fork is a GitHub fork-network repo
  of `docmost/docmost` (`gh repo view`: `isFork: true`, parent `docmost/docmost`). Docmost
  published those files on GitHub itself. Under GitHub's Terms of Service §D.5, an owner who
  publishes a public repo grants every GitHub user a licence to "reproduce Your Content solely on
  GitHub as permitted through GitHub's functionality (for example, through forking)". So the
  unmodified copy in our fork is covered **only while it stays a GitHub fork**. A mirror
  elsewhere (Codeberg, a tarball, a Docker image, a release archive) is not covered. See finding 7.

## 3. Is any EE code in the build or image? [fact]

No, as far as config and the `s9` image show.

- **Build context:** `.dockerignore` excludes `apps/client/src/ee`, `apps/server/src/ee`,
  `packages/ee` and `packages/base-formula`. The builder's `COPY . .` therefore never sees them.
- **Workspace:** `pnpm-workspace.yaml` adds `!packages/base-formula` and `!packages/ee`;
  `@docmost/base-formula` is removed from both apps' `package.json`; `pnpm-lock.yaml` has no
  `base-formula` or `packages/ee` entry.
- **Dockerfile / Dockerfile.hardened:** the two `COPY … packages/base-formula/dist|package.json`
  lines are removed.
- **Client:** `@/ee` is aliased to `/src/droneaid/ee-stubs` in `vite.config.ts` (listed before
  `@`, so it wins), `tsconfig.json` (`paths` plus `exclude: ["src/ee"]`) and
  `vitest.config.ts`. `check-ee-stubs.mjs` flags any relative import that reaches `src/ee`. No
  `import.meta.glob` in core reaches `src/ee`. No core file outside EE imports `@docmost/ee` or
  `base-formula`.
- **Server:** core loads EE only through guarded `require('…/ee/…')` calls (`app.module.ts:39`,
  `license-check.service.ts`, `jwt.strategy.ts`, `import.service.ts`, etc.). The directory is
  absent from the build context, so these calls fail and the code falls back.
  `tsconfig.json` and jest maps no longer alias `@docmost/ee` or base-formula.
- **Image check (re-run for this review):** `docker run docmost-droneaid:s9 find / -xdev`
  for `*/packages/ee*`, `*base-formula*`, `*/src/ee*`, `*/dist/ee*` → **0**. The client assets
  contain no `audit-logs`, `ai-settings`, `base-view` or `mfa` chunk (→ 0). "Docmost Enterprise"
  appears only in core's de-DE/nl-NL `translation.json` strings, which are AGPL.
- **Not re-run:** the sourcemap scan in `droneaid/README.md` ("Enterprise code is not built").
  I relied on the image path and chunk-name scan instead.

Residual risks: see finding 5 (stale artefacts on the dev host). There is also a small future
risk. Someone could restore a dropped Dockerfile line during an upstream merge, or run
`git submodule update --init`, which would fail without access to the private repo. The sync
policy already says to run `check-ee-stubs.sh`; add the image `find` check to it as well.

---

## Findings

### 1. BLOCKER: no Corresponding Source offer to network users (AGPL §13)

**Text [fact]:** §13: "if you modify the Program, your modified version must prominently offer
all users interacting with it remotely through a computer network … an opportunity to receive
the Corresponding Source of your version by providing access to the Corresponding Source from a
network server at no charge".

**State [fact]:**
- No UI element links to `github.com/droneaid-fr/docmost`. The only source-related link is
  `apps/client/src/components/settings/app-version.tsx:40,50`. It points to
  `https://github.com/docmost/docmost/releases` and shows `v0.97.0` (from upstream
  `package.json`, which we did not change). Users who follow it get **upstream's** source, not
  ours. That link reads as an offer of the wrong source, which is worse than no link.
- It appears only in the settings sidebar, so only signed-in members see it. Anonymous readers
  of published pages (`/share/...`, including our `?lang=` translations) also interact with the
  modified server and see nothing.
- The MCP clients (agents, personal tokens) are also remote users. That matters less, because
  they belong to members who see the UI.

**Remedy:**
1. Bake the commit into the build: pass `GIT_SHA` as a Docker build arg. `.dockerignore`
   excludes `.git`, so it cannot be read at build time. Expose it as `VITE_SOURCE_COMMIT` to the
   client and as an env var to the server.
2. Show a "Source code (AGPL-3.0)" link to
   `https://github.com/droneaid-fr/docmost/tree/<sha>` in at least three places:
   - the settings sidebar, replacing the upstream releases link in `AppVersion`, or next to it,
     with the version shown as e.g. `0.97.0-droneaid+<sha7>`
   - the login page footer
   - the public share layout footer
3. Optionally, add a `GET /api/droneaid/source` endpoint that returns `{repo, commit}` for API
   and MCP users.

### 2. SHOULD FIX: make the running version traceable to a public commit

**[fact]** The in-progress deploy files (`docmost-wt/s10-deploy/droneaid/deploy/compose.yml`,
untracked) use `ghcr.io/droneaid-fr/docmost:stable-<sha>`. That gives you the image ↔ commit
mapping. GitHub Actions is disabled on the fork, and the deploy workflow does not exist yet.

**[interpretation]** §13 requires the source "of your version", so it must be available while
that version runs.

**Remedy:** the deploy workflow must:
- push the commit to `origin`, then build, then deploy
- refuse to deploy a sha that is not on a public branch or tag
- never force-push a deployed commit out of reach; tag each deployed sha (`deploy/<date>-<sha7>`)

Corresponding Source includes "the scripts used to control … installation". `Dockerfile` and
`droneaid/docker/build-arm64.sh` are in the repo. Commit the deploy compose and Caddy files
too, minus secrets.

### 3. SHOULD FIX: image metadata and licence text

**[fact]** `Dockerfile` keeps upstream's
`LABEL org.opencontainers.image.source="https://github.com/docmost/docmost"`, so registries and
tools will point to the wrong source. The `s9` image's `/app` contains no `LICENSE` file:
`ls /app` → `apps data node_modules package.json packages patches pnpm-lock.yaml
pnpm-workspace.yaml`.

**[interpretation]** If the GHCR package is ever public, or pulled by anyone outside the
association, that is conveying object code (§6). It must be accompanied by the licence (§4/§6)
and by a source offer (§6(d)). A private package used only on our VM is not conveyed, but the
label is wrong either way.

**Remedy:**
- Set the label to `https://github.com/droneaid-fr/docmost`.
- Add `org.opencontainers.image.revision=$GIT_SHA` and `org.opencontainers.image.licenses="AGPL-3.0"`.
- `COPY LICENSE /app/LICENSE`.
- Decide on purpose whether the GHCR package is public or private.

### 4. SHOULD FIX: modification notice and licence of our own files (§5)

**Text [fact]:** §5(a): "The work must carry prominent notices stating that you modified it, and
giving a relevant date." §5(b): it must state that it is released under this License.

**State [fact]:**
- Root `README.md` is unchanged and still presents the repo as Docmost.
- `droneaid/README.md` says this is a fork, but it gives no date and does not state the licence
  of our additions.
- Of the 43 modified upstream files, 22 contain no "DroneAid" marker at all, e.g.
  `comment-menu.tsx`, `workspace-settings.tsx`, `settings-modal.tsx`, `search-spotlight.tsx`,
  `workspace-invitation.service.ts`, `queue.constants.ts`, `Dockerfile`.
- None of the 272 added files has a licence or copyright header.

**[interpretation]** GPLv3 §5(a) speaks of "the work", not each file as GPLv2 did. One
prominent repo-level notice, with git history giving the per-file detail, is a common and
defensible reading. A per-file `// DroneAid:` marker is nice but not required.

**Remedy:** add a short section at the top of root `README.md`, or a `NOTICE` file:

> "This is DroneAid's modified version of Docmost, modified since 2026-11-08. Our changes are
> listed by `git log main..droneaid`. They are licensed under AGPL-3.0, like Docmost core.
> Copyright (c) 2026 <holder>."

Optionally add `// SPDX-License-Identifier: AGPL-3.0-only` (or `-or-later`, matching what you
decide in finding 12) to new files, and a `"license"` field to `droneaid/migration/export-affine/package.json`.

### 5. SHOULD FIX: stale EE builds on the dev host

**[fact]**
- `docmost-droneaid:pre-s8` exists locally, and the `find` above returns **67** EE paths in it;
  `pre-s8-arm64` exists too.
- `apps/client/dist/` (git-ignored) was built at 2026-11-09 11:33, before S8 (`4868dc5a`,
  14:32). It contains compiled EE chunks (`audit-logs-*.js`, `ai-settings-*.js`,
  `base-view-*.css`, `license-*.js`).
- GHCR returned "denied" for `droneaid-fr/docmost`, so nothing appears to be published. I could
  not list packages because the token lacks `read:packages`.

**[interpretation]** Local copies fall under the EE licence's "development and testing"
allowance. Pushing or deploying them would be production use and distribution without a
subscription.

**Remedy:** `docker rmi docmost-droneaid:pre-s8 docmost-droneaid:pre-s8-arm64`; delete
`apps/client/dist`. Confirm with an authorised token that no pre-S8 tag was ever pushed to GHCR.

### 6. SHOULD FIX (low risk): "Docmost" branding on a modified build

**[fact]**
- The UI still says Docmost (`apps/client/index.html` `<title>Docmost</title>`, the
  apple-mobile-web-app title, the `app-header.tsx` logo and text), and the image is named
  `docmost`.
- I found no published Docmost trademark policy.
- A third-party listing reports a pending USPTO application by Docmost, Inc. for the word mark
  DOCMOST (serial 99727165, filed 2026-03-26, classes 9 and 42). I did not verify this on TSDR.
  ([markinton.com](https://markinton.com/trademark/docmost-99727165))

**[interpretation]** The AGPL grants no trademark rights (§7(e) lets licensors decline them).
Naming the software you run is normally fine. Presenting a modified build as "Docmost" to the
public (share pages) could suggest Docmost made or endorses it, and our bugs would be
attributed to them. The risk is low for a 20-member association, and the fix is cheap.

**Remedy:** brand the instance "DroneAid Base", with "based on Docmost" in the footer or about
area, next to the source link from finding 1. Keep the image name; it is descriptive.

### 7. NOTE: EE files remain in the public fork

**[fact]** They are unchanged and outside the build.
**[interpretation]** Covered by GitHub ToS §D.5 while the repo stays a GitHub fork (see §2).
Deleting them on `droneaid` would not remove them from `main` or from history. It would also
create delete/modify conflicts on every upstream sync. Keeping them is reasonable. Do not
mirror the repo outside GitHub, and do not detach the fork from its network, unless you strip
the EE paths first (`git filter-repo` on the mirror).

### 8. NOTE: EE stubs and interface matching

**[fact]**
- The 48 stub files (356 lines) are inert: they return `null` or `false`, render nothing, or
  render `NotAvailableBlock`.
- Each starts with `// Core expects: …`.
- Spot checks match core call sites:
  - `BaseView` props ↔ `pages/page/page.tsx:146` and `base-embed-view.tsx:145`
  - `IAuthProvider` ↔ `workspace.types.ts:118`
- `features.ts` copies the AGPL core file `apps/server/src/common/features.ts` (same keys).
- The module paths come from core's own `@/ee/...` import specifiers. `check-ee-stubs.mjs` never
  walks `src/ee`.

**[interpretation]** Reproducing the names, paths and signatures that core (AGPL) already
publishes, so that core compiles without EE, is interoperability. It is not copying of
protectable expression. EU Software Directive 2009/24/EC art. 1(2) and SAS Institute v WPL
(C-406/10) hold that functionality and interfaces as such are not protected. Under the
Directive, decompilation for interoperability is permitted (art. 6), and we did not even need
that. I see no problem. Keep the "derive from core only" rule, and keep a record of who wrote
each stub. Provenance is the only thing that could be challenged, and I cannot verify it from
code.

### 9. NOTE: Appropriate Legal Notices (§0, §5(d))

**[fact]**
- Core's English locale has no AGPL, "open source" or warranty strings.
- S8 removed the EE `/settings/license` "License & Edition" route and sidebar item, plus other
  EE pages. No core-rendered legal notice was removed by our diffs to `App.tsx`,
  `settings-sidebar.tsx`, `workspace-settings.tsx` or `settings-modal.tsx`.
- What the EE licence page displayed cannot be checked without reading EE code.

**[interpretation]** If the upstream UI showed no Appropriate Legal Notices, §5(d) does not
require us to add any. The source link in finding 1 can carry "AGPL-3.0, no warranty" text,
which removes the question.

### 10. NOTE: code ported from the AFFiNE fork

**[fact]**
- Ports named in our code: `translate/gemini.ts`, `translate/markdown.ts`, the translate
  module, the `signup-rules.matcher.ts` matcher, and the behaviour of `mcp/tools/databases.ts`
  and `database-ops.ts`.
- In `base/affine/AFFiNE`, every source file these name was added and authored by FilippTrigub:
  `plugins/translate/*` (5 commits), `core/auth/email-allowlist.ts`, and
  `plugins/mcp/tools/{databases,database-edit,database-model,database-markdown,references,workspace-data}.ts`.
- `git blame` of every non-trivial line (≥45 chars) shared between our code and the AFFiNE
  backend finds only 3 lines by an upstream author (DarkSky):
  `async list(userId: string, workspaceId: string) {`,
  `limit: z.number().int().min(1).max(20).optional()`, and an `error instanceof Error ?` idiom.
  These are not copyrightable.
- `plugins/mcp` in the AFFiNE fork began as a move of upstream `plugins/copilot/mcp`
  (commit `aff22c610`). Our Docmost MCP does not share its code; the overlap scan found no
  upstream lines.
- AFFiNE licensing: root `LICENSE` puts `packages/backend` and `packages/common/native` under
  `packages/backend/server/LICENSE`, the "AFFiNE Enterprise Edition (EE) license". It has a
  carve-out: parts "distributed as part of AFFiNE Community Edition (CE)", or served
  client-side, are "under the MPL2.0 license". Everything else is MIT.
- `droneaid/migration/export-affine` imports the AFFiNE fork's modules at runtime from
  `base/affine/AFFiNE`. It contains no AFFiNE code and is not in the image.

**[interpretation]**
- Filipp holds copyright in code he wrote. A licence file in the AFFiNE fork does not take that
  away, so he can license it to the Docmost fork under the AGPL.
- The one theoretical hook is AFFiNE's EE clause that AFFiNE "retain[s] all right … in … such
  modifications". It applies only to modifications of EE-licensed (non-CE) AFFiNE software. Its
  enforceability as a de facto assignment is doubtful, especially in France where copyright
  assignments need formalities (CPI L131-3). The ported pieces are new, self-contained files,
  not edits of AFFiNE code.
- Risk is low. Record it: one line in `droneaid/README.md` saying that these files were written
  by Filipp Trigub, first in the AFFiNE fork, contain no upstream AFFiNE code, and are
  relicensed here under the AGPL.
- The overlap scan is a heuristic, not proof.

Also: `droneaid/hermes/pdf-import.patch` and `SOUL.docmost.diff` patch Hermes-side files
(`affine.py`, `SOUL.md`). I did not trace their authorship. If they are ours, there is nothing
to do.

### 11. NOTE: third-party dependencies

**[fact]**
- `git diff main...droneaid` on every `package.json` adds no dependency. It only removes
  `@docmost/base-formula`, and the lockfile loses 8 lines.
- Packages our code imports are all upstream dependencies already:

  | Package | Version | Licence |
  |---|---|---|
  | `openid-client` | 6.8.2 | MIT |
  | `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 |
  | `fractional-indexing-jittered` | 1.0.0 | CC0-1.0 |
  | `cheerio` | 1.2.0 | MIT |
  | `@sindresorhus/slugify` | 3.0.0 | MIT |
  | `postgres` | 3.4.8 | Unlicense |
  | `kysely-postgres-js` | 3.0.0 | MIT |
  | `zod` | 4.6.7 | MIT |
  | `bullmq` | 5.79.0 | MIT |
  | `uuid` | 14.0.0 | MIT |
  | `y-prosemirror` | 1.3.7 | MIT |

- Gemini is called with plain `fetch` (`translate/gemini.ts`). No SDK is involved.
- `dotenv` (BSD-2-Clause) is used in `apps/server/test/droneaid/french-search.e2e-spec.ts` but is
  not declared. It resolves transitively. This is hygiene, not licensing.

**[interpretation]** All are compatible with AGPL-3.0. Apache-2.0 is GPLv3-compatible one-way,
which is the direction we need. The Gemini API terms of service (data use, regions) are a
service contract, outside code licensing, and are worth a separate look for the privacy notice.

### 12. NOTE: who holds the copyright in our additions

**[fact]** All 50 commits are authored as `FilippTrigub <filipp.trigub@gmail.com>`. Nothing
assigns or licenses them to DroneAid.
**[interpretation]** This is fine for AGPL compliance, but the association should know whether
it owns its platform. Decide on a holder (Filipp, licensing to DroneAid, or a written
assignment) and put it in the notice from finding 4. Also decide `AGPL-3.0-only` or
`-or-later`. Upstream does not say which; `-only` is the conservative match.

---

## Obligations checklist for operating base.droneaid.fr

- [ ] Every page type (app, login, public share) shows a "Source code (AGPL-3.0)" link to
      `github.com/droneaid-fr/docmost/tree/<running sha>`; the version badge no longer points
      at upstream (finding 1)
- [ ] The deployed sha is pushed to the public fork **before** rollout, tagged, and never
      rewritten (finding 2)
- [ ] Deploy scripts and compose files (no secrets) are committed (finding 2)
- [ ] Image: correct `source`, `revision` and `licenses` labels; `LICENSE` included; GHCR
      visibility chosen deliberately (finding 3)
- [ ] Root `README.md` or `NOTICE`: modified-by, since-date, licence and copyright holder of our
      changes (findings 4, 12)
- [ ] After every upstream sync: `droneaid/scripts/check-ee-stubs.sh`, image `find` for EE
      paths returns 0, Dockerfiles still free of `base-formula` lines (§3)
- [ ] Never push or deploy `pre-s8` images or a client `dist/` built before S8; delete them
      (finding 5)
- [ ] Never mirror the repo outside GitHub's fork network with EE paths in it (finding 7)
- [ ] New stubs are written only from core call sites, with the `// Core expects:` line, and
      their author recorded (finding 8)
- [ ] Instance branded "DroneAid Base, based on Docmost" (finding 6)
- [ ] No EE feature is enabled, and no Docmost licence key is entered; none is needed

Sources: repository files cited inline; `docker run docmost-droneaid:{s9,pre-s8}` scans;
`gh repo view droneaid-fr/docmost`; https://docmost.com/docs/editions (fetched 2026-11-10:
"The Open Source edition is … licensed under AGPL-3.0"; "A valid license key is required to
activate Business or Enterprise features"); https://docmost.com/terms (no trademark clause
found); GitHub Terms of Service §D.5; AGPL-3.0 §§0, 4–7, 13 (text in `LICENSE`).

---

## Resolution (S11, 2026-11-10)

Decisions by the user: copyright holder of our modifications is **Trigub Technologies OÜ**
(Tallinn, Estonia), notice reads "© 2025–2026"; our modifications are
**AGPL-3.0-or-later**; the app keeps the name Docmost (no rebrand) but says it is modified;
the GHCR package stays private and the source offer is the public repo at the exact commit.

| # | Finding | Resolution |
|---|---|---|
| 1 | No §13 source offer | **Fixed.** Build arg `SOURCE_COMMIT` → Vite define `DRONEAID_SOURCE_COMMIT` (validated as 7–40 hex) → `apps/client/src/droneaid/source/`. "Source code (AGPL-3.0)" links to `github.com/droneaid-fr/docmost/tree/<sha>` (branch `droneaid` when no sha, e.g. dev) on: settings sidebar (version badge now reads `v0.97.0 · DroneAid <sha7>` and links our source, not upstream's releases), every auth page (`AuthLayout`: login, invite, password reset, setup) and the footer of public share and public space pages (`DocsFooterBranding`). Link title carries "modified version of Docmost … AGPL-3.0, without any warranty" (also covers finding 9). en-US + fr-FR in `droneaid.json`. Not done: a `GET /api/droneaid/source` endpoint for API/MCP clients (optional; their users see the UI). |
| 2 | Running version traceable to a public commit | **Fixed for CI.** The workflow builds `github.sha`, which is always a pushed commit, bakes it into the image and its `revision` label; a comment forbids rewriting a deployed commit. `build-arm64.sh` passes `HEAD` and warns on a dirty tree. Deploy compose/Caddy files were committed in S10. Deferred: tagging each deployed sha (`deploy/<date>-<sha7>`) in the deploy job, and a guard refusing a sha not on a public branch (manual dispatch can build any pushed ref, which is still public). |
| 3 | Image metadata and licence text | **Fixed.** `Dockerfile`: `source=https://github.com/droneaid-fr/docmost`, `revision=$SOURCE_COMMIT`, `licenses=AGPL-3.0-or-later`; `LICENSE` and `NOTICE.md` copied to `/app`. The workflow's own `labels:` override was removed so the Dockerfile is the single source. GHCR package stays private (decided). `Dockerfile.hardened` (unused by us) still has upstream's label. |
| 4 | §5 modification notice | **Fixed.** Root `NOTICE.md`: modified version of Docmost, modified since 2026-11-08 by Trigub Technologies OÜ, copyright and AGPL-3.0-or-later for our changes, upstream core AGPL-3.0, EE dirs not built and not licensed by us, where our code lives, no per-file headers (NOTICE covers every file). Short "DroneAid fork" banner at the top of root `README.md`; `droneaid/README.md` points to it. No SPDX headers added (decided: too noisy). |
| 5 | Stale EE builds on the dev host | **Done by the user** before S11: `pre-s8` images and the pre-S8 `apps/client/dist` were deleted. Still open: confirm with a `read:packages` token that no pre-S8 tag was ever pushed to GHCR. |
| 6 | Docmost branding | **Decided: keep the name.** The modification is stated in `NOTICE.md`, the README banner, the link title and the version badge ("DroneAid <sha>"). "Powered by Docmost" stays. |
| 7 | EE files in the public fork | No change (stays a GitHub fork; NOTICE says we license nothing there). |
| 8 | Stub provenance | No change; rule stands. |
| 9 | Appropriate Legal Notices | Covered by the source link and its title text (licence + no warranty). |
| 10 | AFFiNE-origin code | Recorded in `NOTICE.md` (written by Filipp Trigub in the AFFiNE fork, no upstream AFFiNE code, relicensed AGPL-3.0-or-later). Hermes patch authorship still untraced. |
| 11 | Dependencies | No change needed. |
| 12 | Copyright holder / or-later | **Decided:** Trigub Technologies OÜ, AGPL-3.0-or-later (compatible with upstream's unversioned "AGPL 3.0"). Whether DroneAid gets a licence or assignment from the holder is outside this repo. |
