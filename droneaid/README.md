# DroneAid fork of Docmost

This is DroneAid's fork of [docmost/docmost](https://github.com/docmost/docmost). It runs the
free AGPL-3.0 edition, built from source, and replaces our self-hosted AFFiNE at
`base.droneaid.fr`. The migration plan and design decisions live outside this repo, in
`base/docmost-migration.md`.

The fork is public because the AGPL requires it: anyone who uses a modified server must be
able to get its source.

## Rules

- **Clean room.** Never open, copy or reuse anything under the Docmost Enterprise License:
  `apps/server/src/ee` (a private submodule that we never init), `apps/client/src/ee`,
  `packages/ee` and `packages/base-formula`. We re-implement such features ourselves.
- **Our code goes in our own directories:**
  - server: `apps/server/src/droneaid/<module>/`
  - client: `apps/client/src/droneaid/<feature>/`
  - editor extensions: `packages/editor-ext/src/lib/droneaid/<ext>/`
  - migrations: `apps/server/src/database/migrations/`, with `droneaid` in the file name
- Edit upstream files only to register our code (module import, route, extension list, button
  slot). Record every such edit in the migration plan's "Conflict-prone upstream touches"
  table.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Mirrors upstream `main`. Later (Phase 7) it becomes what we deploy. Nothing of ours lands here before then. |
| `droneaid` | Integration branch: our work on top of upstream `main`. |
| `feat/<step>` | One branch per step, created from `droneaid` in a worktree at `base/docmost-wt/<step>`. It merges back into `droneaid` once the step's check passes. |

Remotes: `origin` = `droneaid-fr/docmost`, `upstream` = `docmost/docmost`. We pull upstream
releases deliberately, never continuously. Never push to `main` and never open PRs against
`docmost/docmost`.

GitHub Actions is **disabled** on the fork, so upstream's `release.yml` cannot run on our tag
pushes. We add our own deploy workflow in Phase 7.

## Dev setup

You need Node 26 (the version in the `Dockerfile`) and pnpm 12.16.1 (the version in
`package.json`). Node 26 ships without corepack, so install pnpm globally:

```bash
nvm install 26 && nvm use 26
npm install -g pnpm@12.16.1
pnpm install --frozen-lockfile
```

Start Postgres 18 and Redis 8. The example uses the S1 port block; every step uses its own
block, listed in the migration plan.

```bash
docker run -d --name docmost-s1-pg -e POSTGRES_DB=docmost -e POSTGRES_USER=docmost \
  -e POSTGRES_PASSWORD=docmost -p 127.0.0.1:5541:5432 -v docmost-s1-pg:/var/lib/postgresql postgres:18
docker run -d --name docmost-s1-redis -p 127.0.0.1:6391:6379 redis:8
```

Create the root `.env` (git-ignored). The server, the migration CLI and Vite all read it.
`APP_URL` must point at the **server**, because Vite proxies `/api`, `/socket.io` and
`/collab` to it.

```dotenv
APP_URL=http://localhost:3100
PORT=3100
APP_SECRET=<openssl rand -hex 32>
DATABASE_URL=postgresql://docmost:docmost@localhost:5541/docmost
REDIS_URL=redis://127.0.0.1:6391
STORAGE_DRIVER=local
DISABLE_TELEMETRY=true
```

Run the migrations once. Dev mode does not run them; production runs them on boot.

```bash
cd apps/server && pnpm migration:latest
```

Start the dev servers, each in its own terminal:

```bash
# build shared packages once (pnpm run server:dev does this through nx, but buffers its output)
NX_DAEMON=false npx nx run-many -t build -p @docmost/editor-ext @docmost/base-formula
cd apps/server && pnpm start:dev                 # Nest in watch mode on :3100
cd apps/client && npx vite --port 5100 --strictPort   # UI on http://localhost:5100
```

On first start, open `http://localhost:5100` to run setup (workspace and owner account), or
call the API directly: `POST /api/auth/setup {name,email,password,workspaceName}`.

After you change `packages/editor-ext`, rebuild it with `pnpm editor-ext:build`. The server
imports `dist/`.

### Tests

```bash
cd apps/server && pnpm test        # Jest unit tests (src/**/*.spec.ts)
cd apps/server && pnpm test:e2e    # Jest e2e (test/*.e2e-spec.ts; upstream has only a stub)
cd apps/client && NODE_OPTIONS=--no-webstorage pnpm test   # Vitest
```

Baseline on upstream v0.97.0 with Node 26:
- Client: 469/469 tests pass. They pass only with `--no-webstorage`, because Node 26's
  built-in `localStorage` shadows jsdom's. The Dockerfile sets the same flag.
- Server: 1044/1059 tests pass (63/80 suites). The 17 suites that fail were already broken
  upstream: Nest scaffold "should be defined" specs that lack providers, a constructor
  argument-count mismatch in `workspace.service.spec.ts`, and an ESM parse error in
  `static.module.spec.ts`. Compare against this baseline; do not try to make the suite green.

### Database

```bash
cd apps/server
pnpm migration:create <name_with_droneaid>   # new file in src/database/migrations
pnpm migration:latest | migration:down
pnpm migration:codegen                        # regenerate src/database/types/db.d.ts from the live DB
```

## Images

The build uses the repo's own `Dockerfile`. A source build never contains the EE server
module, so the image is the free edition.

```bash
# amd64, loaded into the local engine (~100 s on the dev host)
docker buildx build --platform linux/amd64 -t docmost-droneaid:local --load .

# arm64 (the production VM), cross-built on amd64 (~45 s cold); register qemu once with:
docker run --privileged --rm tonistiigi/binfmt --install arm64
droneaid/docker/build-arm64.sh                       # -> ./docmost-arm64.tar
droneaid/docker/build-arm64.sh docmost-droneaid:local-arm64 type=cacheonly   # build only
docker load -i docmost-arm64.tar
```

Do not build arm64 with a plain `docker buildx build --platform linux/arm64 .`. Under qemu
emulation, the client's `vite build` (rolldown) deadlocks: every thread sleeps and the build
never finishes (seen twice in S1). `build-arm64.sh` takes upstream's `Dockerfile` unchanged
and derives a variant in which only the `builder` stage runs natively
(`FROM --platform=$BUILDPLATFORM`). That stage only emits platform-independent `dist/`
JavaScript. The installer stage still installs native modules (bcrypt, ...) for arm64 under
qemu, and the runtime is arm64. In CI, a native arm64 runner can use the plain `Dockerfile`.

## Local stack

`droneaid/local/compose.yml` runs our image with Postgres 18 and Redis 8. It uses the
integration (S7) ports: app 3000, Postgres 5540, Redis 6390, all bound to 127.0.0.1.

```bash
cd droneaid/local
cp .env.example .env    # fill APP_SECRET and POSTGRES_PASSWORD; .env is git-ignored
docker compose up -d    # set DOCMOST_IMAGE=... to run another tag
curl -s localhost:3000/api/health
```

Then open `http://localhost:3000` and complete setup.

## Google sign-in (`apps/server/src/droneaid/google-auth`)

Off unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in `.env`. The login
page asks `GET /api/droneaid/auth/google/config` and shows "Continue with Google" only when
it returns `{ enabled: true }`.

- Redirect URI to register on the Google OAuth client: `${APP_URL}/api/droneaid/auth/google/callback`
  (production: `https://base.droneaid.fr/api/droneaid/auth/google/callback`).
- Flow: `GET /api/droneaid/auth/google` → Google (state, nonce, PKCE S256; the transaction is
  an HMAC-signed httpOnly cookie) → callback → `authToken` cookie and `/home`, or
  `/login?google_error=<code>`.
- A Google account is linked in core `auth_accounts` against one `auth_providers` row of type
  `google`, created on first use with `is_enabled=false` (so licence-gated SSO code never sees
  it) and `allow_signup=false`. Existing users (matched by email, case-insensitive) always
  sign in and get linked. Unknown emails sign up only if `allow_signup` is true **and** the
  domain passes `workspaces.email_domains`. Until the S2b admin screen exists, toggle signup
  with `update auth_providers set allow_signup = true where type = 'google';`.
- `GOOGLE_OIDC_ISSUER` overrides the issuer (default `https://accounts.google.com`); tests only.
- MCP agent accounts (users with a `droneaid_agents` row) are refused like disabled accounts:
  Google never signs in as an agent and is never linked to one, whatever its email.
- **No MFA in this build.** MFA (enrolment, TOTP check, the `mfa_token` step) is EE: core's
  password login runs it only through `require('./ee/mfa/...')`, which a source build lacks,
  so password login never asks for a second factor either, even with
  `workspaces.enforce_mfa` set (core sets that flag without a licence check, but only its
  invitation and password-reset paths read it, to send the user to the login page). Google
  sign-in therefore applies no MFA check; there is nothing to enforce. Revisit if we ever
  build MFA ourselves.

E2E against a mock provider (needs the dev server running with the mock issuer):

```bash
docker run -d --name docmost-s2-oidc -p 127.0.0.1:8292:8080 ghcr.io/navikt/mock-oauth2-server:2.1.10
# .env: GOOGLE_CLIENT_ID=docmost-test GOOGLE_CLIENT_SECRET=docmost-test-secret
#       GOOGLE_OIDC_ISSUER=http://localhost:8292/default
cd apps/server && pnpm test:e2e -- droneaid/google-auth
```

## French search

Page full-text search uses the text search configuration `droneaid_search`, a copy of
Postgres's `french`, instead of upstream's `english` (migration
`20261109T180000-droneaid-french-search.ts`, which also rebuilds `pages.tsv`). Accents were
already ignored upstream through `f_unaccent`; the French stemmer adds plural/feminine forms
(`dangereuse` → `dangereux`, `nationaux` → `nationales`) and French stop words. The name is a
constant in `apps/server/src/droneaid/search/search-config.ts`, used by
`core/search/search.service.ts`. If an upstream migration ever redefines
`pages_tsvector_trigger()`, re-apply the config in a new droneaid migration.

```bash
cd apps/server && pnpm test:e2e -- droneaid/french-search   # needs the step's Postgres with migrations
```

## MCP (`apps/server/src/droneaid/mcp`)

- Route `POST /api/droneaid/mcp`, 24 MiB body limit on that route only. A route-level
  `onRequest` hook refuses requests without a well-formed, valid `Authorization: Bearer`
  token (agent token row, or JWT signature and expiry) before the body is read. `main.ts`
  sets Nest's `rawBody` for every route, so the JSON parser still makes a Buffer copy of the
  body; a route `preHandler` drops it right after parsing (avoiding it entirely would mean
  editing `main.ts`).
- Throttle: 120 requests per minute per token (`McpThrottlerGuard`, core's ThrottlerGuard and
  Redis storage with its own throttler).
- `update_document` never rebuilds what Markdown cannot carry. Databases, synced blocks
  (`transclusionSource`), columns and tabs are kept whole: `read_document` shows a database as
  one marker line and the others between `<!-- <kind> id=... start ... -->` and
  `<!-- <kind> id=... end -->` lines; the live block goes back where its marker stands (text
  edited between the lines is ignored, with a warning), else at the end. Columns and tabs are
  numbered by rank (they have no id). Files, embeds, diagrams and page breaks are kept by link
  or anchor. A block whose Markdown is unchanged is reused from the live doc, so comment marks,
  alignment, colours, highlights and status badges survive; same text with new formatting gets
  the live attributes and comment marks back; comments and formatting lost to real rewrites
  are listed in `warnings`.

## Hermes agent cutover files (`droneaid/hermes/`)

Checked in S3c against a local Docmost with a test copy of the DA France profile.

- `SOUL.docmost.diff`: the knowledge-base section of the agent's `SOUL.md` for Docmost (spaces,
  folders as pages, no AFFiNE naming). Apply with `patch SOUL.md < SOUL.docmost.diff`; then
  replace the Guest list doc id (`GZFuJceixu`) with the migrated doc's id.
- `pdf-import.patch`: `mcp/pdf-import` returns the `url` Docmost reports (from
  `create_document`, or `get_document_info` for an existing doc) and still builds the AFFiNE
  link when the endpoint is AFFiNE's. Apply with `git apply` in `mcp/pdf-import`. Its config
  keeps the env names `AFFINE_MCP_URL` / `AFFINE_MCP_TOKEN`; point them at
  `https://<host>/api/droneaid/mcp` and the agent's `dmcp_` token.

## Translation of published pages (`apps/server/src/droneaid/translate`)

Port of our AFFiNE fork's `plugins/translate`. Off unless `TRANSLATE_ENABLED=true`.

| Env var | Meaning |
|---|---|
| `TRANSLATE_ENABLED` | `true` turns the feature on (UI, API and the job). |
| `GEMINI_API_KEY` | Gemini key. Without it every job fails with "not configured". Core also reads this name for its AI features; both may share the key. |
| `GEMINI_MODEL` | Default `gemini-3.5-flash-lite`. |
| `TRANSLATE_GEMINI_BASE_URL` | Tests only: point the client at a fake Gemini. |
| `TRANSLATE_REFRESH_QUIET_MINUTES` | An edited page is translated again once it has had no edits for this long. Default 10; fractional values allowed (tests use 0.1). |

There is no admin settings toggle: the switch and the key live in the server environment,
like the Google sign-in keys.

- **Choosing languages:** the **Translations** button beside **Share** in the page header
  (shown while the page is shared to the web) holds the source language, the target
  languages (EN, FR, ES, PT, DE, PL, NL), each language's status, an "Out of date" flag and
  **Update translations**. Core's share menu is an EE component, so the panel has its own
  popover. Only users who could share the page (edit right, sharing allowed, no restricted
  ancestor) can change it.
- **Job:** a BullMQ job scheduler on `{droneaid-translate}` ticks every 30 s (saving or Update
  adds a tick 2 s later; kicks within that window share one job id, so a burst costs one tick).
  Each tick deletes translations of pages that are trashed or no longer shared (one SQL
  statement following core's share rule), queues again the translations of pages edited and
  then left alone for `TRANSLATE_REFRESH_QUIET_MINUTES` (one SQL statement), then translates
  due rows one language at a time, refreshing the row's `updated_at` after each chunk so a long
  page is never handed to a second instance: each text block of the page becomes one
  Markdown block (Docmost's JSON → Markdown export), blocks are packed into ~4000-character
  chunks for Gemini, each chunk is structure-checked (block count, heading level, ⟦n⟧
  placeholders, link targets) with one retry, and a 429 backs off 1 min, doubling, up to six
  times. The translated blocks come back through Docmost's Markdown → JSON path and only
  replace the text of their block.
- **Kept untranslated in place:** databases (cell values are data), images, files, embeds,
  video, Draw.io, Excalidraw, math, code blocks, sub-page lists, transclusion references; inline
  mentions, inline math and status chips travel as ⟦n⟧ placeholders. Nothing makes a page
  fail. Lost inside translated text: underline and text colour.
- **Storage:** `droneaid_page_translations` (one row per page and language, ProseMirror
  `content` snapshot, `source_hash`, and `source_updated_at` = the page's `updated_at` when
  translated). Not pages, so never in the tree or search.
- **Readers:** `POST /api/droneaid/translate/shared {pageId, lang?}` (public, same gate as core's
  share page-info). The share page shows a language menu; `?lang=xx` picks a language, and an
  unknown one shows the original. The share page's `<title>`, `og:title` and `<html lang>`
  follow `?lang=` too.
- **Out of date:** a translation is served only while it was made from the page's current text.
  Readers (`/shared`, the language menu, the SEO title) get the original as soon as an edit is
  saved: a page not saved since translation passes on `source_updated_at` alone, in SQL; a
  page saved since is hashed, and a save that left the text unchanged (a move, an icon) is
  marked current again. The source hash ignores block ids, schema defaults and comments, so
  opening a page does not flag it. Re-translation is automatic after the quiet period (the
  model is not called when the text did not actually change); **Update** forces it at once.
- **Unpublishing** deletes the page's translations on the next tick (≤ 30 s); a deleted page
  takes them with it (foreign key).

E2E against a fake Gemini (the test serves it on 127.0.0.1:8295; start the dev server with
`TRANSLATE_ENABLED=true GEMINI_API_KEY=fake-key
TRANSLATE_GEMINI_BASE_URL=http://127.0.0.1:8295/v1beta/models
TRANSLATE_REFRESH_QUIET_MINUTES=0.1` in `.env`):

```bash
DRONEAID_E2E_URL=http://localhost:3500 DRONEAID_E2E_EMAIL=... DRONEAID_E2E_PASSWORD=... \
  pnpm --filter server test:e2e -- droneaid-translate
```
