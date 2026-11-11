# DroneAid fork of Docmost

This is DroneAid's fork of [docmost/docmost](https://github.com/docmost/docmost). It runs the
free AGPL-3.0 edition, built from source, and replaces our self-hosted AFFiNE at
`base.droneaid.fr`. The migration plan and design decisions live outside this repo, in
`base/docmost-migration.md`.

The fork is public because the AGPL requires it: anyone who uses a modified server must be
able to get its source.
Copyright, licence (`AGPL-3.0-or-later` for our changes) and the modification notice are
in the root [`NOTICE.md`](../NOTICE.md). Every page links its exact source commit
(`apps/client/src/droneaid/source/`); images get the commit as build arg `SOURCE_COMMIT`.

## Rules

- **Clean room.** Never open, copy or reuse anything under the Docmost Enterprise License:
  `apps/server/src/ee` (a private submodule that we never init), `apps/client/src/ee`,
  `packages/ee` and `packages/base-formula`. We re-implement such features ourselves.
  None of these is built or shipped (see "Enterprise code is not built"); core's `@/ee/...`
  imports resolve to our stubs in `apps/client/src/droneaid/ee-stubs/`.
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
| `main` | Mirrors upstream `main`. Nothing of ours lands here. |
| `droneaid` | Integration branch: our work on top of upstream `main`. GitHub default branch. |
| `production` | Promotion branch: a push deploys (`git push origin droneaid:production`). See [`deploy/README.md`](deploy/README.md). |
| `feat/<step>` | One branch per step, created from `droneaid` in a worktree at `base/docmost-wt/<step>`. It merges back into `droneaid` once the step's check passes. |

Remotes: `origin` = `droneaid-fr/docmost`, `upstream` = `docmost/docmost`. We pull upstream
releases deliberately, never continuously. Never push to `main` and never open PRs against
`docmost/docmost`.

### Upstream sync policy

- Merge an upstream release into `droneaid` on its own branch, then run the full checks
  below before promoting.
- **Run `droneaid/scripts/check-ee-stubs.sh` after every sync.** Upstream often adds a new
  `@/ee/...` import to core. The client build then fails until a stub exists for it, because
  `@/ee` resolves only to `apps/client/src/droneaid/ee-stubs/`. The script lists every `@/ee`
  path and imported name that core uses and names each one the stubs lack. It also flags a
  relative import that reaches `src/ee` (it would bypass the alias). It runs inside the client
  tests too (`src/droneaid/ee-stubs/ee-stubs.test.ts`). Write a missing stub from the core
  call site only (what it imports, the props it passes, what it reads back), never from the EE
  file; start the file with a one-line `// Core expects: ...` comment, which the script checks.
- After a sync touching the editor, collaboration or auth, re-run the database-block and
  sign-in e2e tests.
- Re-check that new Enterprise UI in core is hidden, not greyed out (see "Removed Enterprise
  features (S8)").

GitHub Actions is enabled on the fork for our own workflow only:
`.github/workflows/droneaid-deploy.yml` builds `ghcr.io/droneaid-fr/docmost:stable-<sha9>`
(arm64, native runner) and, on a push to `production`, rolls it out to the VM. Upstream's
`release.yml` is disabled (`gh workflow disable release.yml`); re-check after a sync that
adds a new upstream workflow, and disable it too. Deploy, rollback, backups and the cutover
runbook: [`deploy/README.md`](deploy/README.md).

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
NX_DAEMON=false npx nx run-many -t build -p @docmost/editor-ext
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
droneaid/scripts/check-ee-stubs.sh                         # every @/ee import has a stub
```

Since S8 (2026-11-09): client 528/528 (the 6 test files under `src/ee`, 17 tests, are no
longer run; 5 tests were added: stubs, checker, Translations button); server 1415/1430 with the same 17 upstream
suites failing.

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

### Enterprise code is not built

- `.dockerignore` keeps `apps/client/src/ee`, `apps/server/src/ee`, `packages/ee` and
  `packages/base-formula` out of the build context, so the builder stage never sees them.
- `pnpm-workspace.yaml` excludes `packages/base-formula` and `packages/ee`; no app depends on
  `@docmost/base-formula`; the Dockerfiles no longer copy its `dist`.
- The client's `@/ee` alias (`vite.config.ts`, `tsconfig.json`, `vitest.config.ts`) points at
  `apps/client/src/droneaid/ee-stubs/`; `src/ee` is excluded from tsc, ESLint and Vitest.

Check an image and a client build:

```bash
# no Enterprise path in the image
docker run --rm --entrypoint sh docmost-droneaid:local -c \
  'find / -xdev \( -path "*/packages/ee*" -o -path "*base-formula*" -o -path "*/src/ee*" -o -path "*/dist/ee*" \) -print' | wc -l   # 0
# no module from src/ee in the bundle: build with sourcemaps and scan every map's sources
cd apps/client && npx vite build --sourcemap --outDir /tmp/client-maps --emptyOutDir
node -e 'const fs=require("fs");let n=0;for(const f of fs.readdirSync("/tmp/client-maps/assets"))if(f.endsWith(".map"))for(const s of JSON.parse(fs.readFileSync("/tmp/client-maps/assets/"+f)).sources)if(/src\/ee\/|packages\/ee\/|base-formula/.test(s))n++;console.log(n)'   # 0
```

```bash
# amd64, loaded into the local engine (~100 s on the dev host)
docker buildx build --platform linux/amd64 --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -t docmost-droneaid:local --load .

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

## Local verification stack

`droneaid/local/compose.yml` runs our image with the migrated AFFiNE data, for manual checks
before deployment. It uses the integration (S7) ports, all bound to 127.0.0.1.

| Service | Address | Purpose |
|---|---|---|
| `docmost` | http://localhost:3000 | our image `docmost-droneaid:local` (`DOCMOST_IMAGE` picks another tag) |
| `db` | localhost:5540 | Postgres 18 |
| `redis` | localhost:6390 | Redis 8 |
| `mailpit` | http://localhost:8025 | catches every mail the app sends (password reset, invitations) |
| `fake-gemini` | (internal) | stand-in for Gemini: appends ` [fake-<lang>]` to each block instead of translating |

Secrets live in `droneaid/local/.env` (untracked, mode 600; template `.env.example`):
`APP_SECRET`, `POSTGRES_PASSWORD`, `DOCMOST_AGENT_TOKEN` and `LOCAL_FILIPP_PASSWORD`.

### Start, stop, status

```bash
docker buildx build --platform linux/amd64 --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t docmost-droneaid:local --load .   # after code changes
cd droneaid/local
docker compose up -d          # start (restart policy unless-stopped: it comes back after a reboot)
docker compose ps
curl -s localhost:3000/api/health
docker compose stop           # stop, keep data
docker compose up -d docmost  # pick up a rebuilt image
```

### Sign in

Open http://localhost:3000 and sign in with email `filipp@droneaid.fr` and the password
stored as `LOCAL_FILIPP_PASSWORD` in `droneaid/local/.env`:

```bash
grep ^LOCAL_FILIPP_PASSWORD= droneaid/local/.env
```

Imported users have no usable password (production signs them in with Google). To set or
change the password of any imported user, use Docmost's own reset: on the login page click
**Forgot your password?**, enter the email, open the mail in mailpit (http://localhost:8025),
follow the link and choose a password. If you change filipp's password, update
`LOCAL_FILIPP_PASSWORD` too.

### What is imported

The S6 bundle `base/backups/migration-bundle-20261109T093335Z/`, imported as
`droneaid/migration/RUNBOOK.md` step 3 prescribes for production: the importer runs inside
the app container against the empty database, then `--verify`. Reports:
`base/backups/import-docmost-s7-local-20261109/` (`verify.md`: PASS).

- 4 spaces (DroneAid France, DroneAid Academy, DroneAid R&D, Demo Workspace), plus Docmost's
  own empty General. Since S12 the importer leaves Demo Workspace out and deletes General;
  re-import (`./run.sh reset-local --yes`, then RUNBOOK step 3) to get that state here.
- 15 human users and the DroneAid France agent.
- 56 live doc pages, 13 folder pages and 36 trashed docs (in the Docmost trash).
- 97 files.
- 10 databases, every cell equal to the bundle (Target List 777×8; Guests in
  *Participant list*, 201×23).
- 6 public shares, 3 translations, 2 comments, 4 signup rules and 30 internal links.

Demo Workspace has one member, `mark.p@drone-aid.nl`, as in AFFiNE. Docmost lists a private
space only to its members, even for the workspace owner, so filipp does not see it.

### Agent token and test agent

`DOCMOST_AGENT_TOKEN` in `droneaid/local/.env` is a token of *DroneAid France agent*, minted
in **Settings → Agents**. The test Hermes profile `~/.hermes/profiles/da-france-docmost-test`
(S3c's copy, never the live `da-france-agent`; no WhatsApp, Resend, Luma or Google Drive)
points at `http://localhost:3000/api/droneaid/mcp` with that token, for both its `docmost`
MCP server and its `pdf-import` copy (`MCP_DOCMOST_TOKEN` in the profile's `.env`).

```bash
hermes -p da-france-docmost-test -z "Search for 'Target List' and tell me how many rows its database has."
```

After minting a new token, put it in both `.env` files and revoke the old one in
Settings → Agents.

### Differences from production

- **No Google sign-in.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are unset, so the
  login page has no Google button: the localhost callback is not registered on the real
  OAuth client. Users sign in with a password set through mailpit.
- **No real translation.** `TRANSLATE_GEMINI_BASE_URL` points at `fake-gemini`, which only
  tags text. The 3 imported translations are real (made by AFFiNE's Gemini) and are served
  until their page is edited. For real translations, set `GEMINI_API_KEY` to a real key,
  delete `TRANSLATE_GEMINI_BASE_URL` from `.env` and run `docker compose up -d docmost`.
- **Mail never leaves the machine** (mailpit instead of Resend SMTP).
- **No Caddy**, so old AFFiNE URLs do not redirect here. The snippet in the import reports
  was checked separately with a local `caddy:2` in front of this stack.
- amd64 image; production runs the arm64 build of the same commit.

### Reset and re-import

This deletes every page, user and file of the local stack.

```bash
cd droneaid/local
docker compose down -v && docker compose up -d     # empty DB; the app runs migrations on boot
until curl -sf localhost:3000/api/health >/dev/null; do sleep 2; done
B=../../../backups/migration-bundle-20261109T093335Z
docker compose cp "$B" docmost:/tmp/bundle
docker compose exec -w /app/apps/server docmost \
  node dist/droneaid/migration/import-cli.js --bundle /tmp/bundle --out /tmp/import --verify
docker compose cp docmost:/tmp/import ../../../backups/import-docmost-local-$(date +%Y%m%d%H%M)
docker compose exec docmost rm -rf /tmp/bundle /tmp/import
```

Then set filipp's password again (Forgot password + mailpit), mint a new agent token, and put
it in both `.env` files (`DOCMOST_AGENT_TOKEN` here, `MCP_DOCMOST_TOKEN` in the test profile).

The manual verification checklist is [`VERIFY.md`](VERIFY.md).

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

## Personal MCP tokens (`apps/server/src/droneaid/personal-tokens`, S9)

Any human member can connect their own MCP client (Claude, Cursor, ...) to
`${APP_URL}/api/droneaid/mcp` and act as themselves.

- **Where:** Settings → Account → *MCP tokens* (`/settings/account/droneaid/mcp-tokens`,
  client in `apps/client/src/droneaid/personal-mcp/`). The page shows the endpoint, a
  one-time reveal of a new token with an example `mcpServers` JSON and a `claude mcp add`
  command, and the caller's tokens (name, prefix, created, last used, expiry, revoke).
- **API** (session JWT only, `@RequireSessionAuth`; always the caller's own tokens, no user id
  parameter): `POST /api/droneaid/personal-tokens` (list → `{allowed, maxActive, tokens}`),
  `/create {name, expiresInDays?}` → `{token, record}`, `/revoke {tokenId}` (404 for anyone
  else's token).
- **Storage:** table `droneaid_user_mcp_tokens` (migration
  `20261112T090000-droneaid-user-mcp-tokens`), sha256 hash + 12-char display prefix only.
  Tokens are `dmcpu_` + 43 base64url chars; agent tokens stay `dmcp_` in
  `droneaid_agent_tokens`. The prefix routes a token to its table, so a token's kind is never
  ambiguous. Neither is a JWT, so no other route accepts them.
- **Expiry:** optional (UI: 30 / 90 (default) / 365 days or never; API: 1-3650 days or none).
  `last_used_at` is written at most once a minute.
- **Cap:** 10 live (not revoked, not expired) tokens per user, checked under a row lock on the
  user.
- **Checks on every MCP request** (`PersonalTokenService.authenticate` + `McpAuthGuard`):
  token not revoked or expired; user still in the token's workspace, not deactivated, not
  deleted; not an agent account; workspace = the request host's workspace. The principal is
  the same as for a session JWT (`isAgent: false`, no agent space), so every tool applies the
  member's own space and page permissions.
- **Agents** cannot mint (403) and the sidebar item is hidden for them (the list endpoint
  returns `allowed: false`).
- **Deactivation/removal** stops a member's tokens at once (they are refused, not revoked).
  Reactivating the member makes their unrevoked tokens work again.
- **Admins** cannot list or revoke members' tokens yet (follow-up); deactivating the member is
  the kill switch.

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
  **Update translations**. The panel has its own popover next to core's Share popover and
  appears as soon as the page is shared there. Only users who could share the page (edit
  right, sharing allowed, no restricted ancestor) can change it.
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

## Removed Enterprise features (S8)

Docmost's Enterprise code (`apps/client/src/ee`, `packages/ee`, `packages/base-formula`; the
server half `apps/server/src/ee` was never present) is not part of our build. Core reaches it
through `@/ee/...` imports, which resolve to inert stubs in
`apps/client/src/droneaid/ee-stubs/`: every licence check is off, upgrade labels render
nothing, components render nothing. Where a page holds content an Enterprise feature made (an
embedded Base), it shows a neutral "Base is not available in this edition" block; the node
stays in the document.

What these features offered, in Docmost's public words (descriptions from the pages cited
below and from names visible in core, never from the Enterprise code):

| Feature (Docmost name) | What it offered | Replacement | Where |
|---|---|---|---|
| MCP server ("AI & MCP") | AI clients search, read, create and update pages over MCP, authorised by OAuth or API key. | **Ours** | `POST /api/droneaid/mcp`; agents and tokens in Settings → Agents |
| Bases (incl. Kanban) | Table and Kanban views with properties, filters, sorts and formulas. | **Ours**: the database block | slash menu → Database; Base embeds from upstream pages show the neutral block |
| Page-level permissions | View and edit rights on single pages. | **Core space roles** | Space settings → Members; the agent writes only in its own space |
| SSO: SAML 2.0, OIDC, LDAP; enforce SSO | Sign-in through the company identity provider or directory. | none | |
| Google SSO | Google as an SSO provider. | **Ours** | "Continue with Google" (`/api/droneaid/auth/google`) |
| Security & SSO settings (incl. allowed email domains) | Admin screen for SSO providers and sign-up domains. | **Ours** for sign-up domains | Settings → Sign-up rules |
| MFA (two-factor, TOTP) | Authenticator-app second factor at sign-in. | none | |
| API keys, API management | Personal REST API keys and admin key management. | none (agent tokens cover the agent) | Settings → Agents |
| OAuth apps ("Authorized apps") | MCP clients authorised by OAuth, revocable per user. | none (agent tokens) | |
| Audit logs | Record of sign-ins, membership, permission, sharing and integration changes. | none | |
| SIEM / log streaming | Audit events streamed to Splunk, Datadog or HTTP. | none | |
| SCIM provisioning | Users and groups provisioned and deactivated from the identity provider. | none | |
| AI: AI Chat, AI Answers in search, Ask AI in the editor, AI settings | Workspace Q&A, natural-language search answers, writing help on selected text. | none (our machine translation of published pages is a separate feature) | |
| Page verification | Review, verify and approve pages. | none | |
| Templates | Create and reuse page templates. | none | |
| Comment resolution | Mark comment threads resolved. | none | |
| DOCX import, PDF import, Confluence import | Import Word, PDF and Confluence exports as pages. | core Markdown/HTML/Notion/ZIP import; the agent's PDF import (Hermes `pdf-import` over our MCP) | Space menu → Import pages |
| DOCX export, PDF export | Word and server-rendered PDF export. | core Markdown/HTML export; browser print | Page menu → Export |
| Attachment search | Full-text search inside PDF and DOCX attachments. | none (core page search, French config ours) | |
| Personal spaces | A private space per user. | none | |
| Sharing controls, viewer comments (space Security tab) | Turn public sharing off per workspace or space; let viewers comment. | none (public sharing itself is core) | |
| Retention controls | Audit-log and data retention settings. | none | |
| Typesense search driver | Alternative search engine. | core Postgres search | |
| Public space appearance | Colours of the public docs site (beta public spaces). | none | |
| Licence & Edition, billing, trial, cloud hostname | Licence key, plans and cloud workspace setup. | not applicable | |

What disappeared from the UI:

- Routes: `/settings/security`, `/settings/api-keys`, `/settings/account/api-keys`, `/settings/ai`,
  `/settings/audit`, `/settings/siem`, `/settings/verifications`, `/settings/license`,
  `/settings/billing`, `/templates`, `/base/:pageId`, `/ai`, `/login/mfa`, `/oauth/consent`,
  `/pdf-render/:pageId`, and the cloud-only `/create`, `/select`, `/verify-email`.
- Settings sidebar: API keys, Security & SSO, Verified pages, API management, AI settings, Audit
  logs & SIEM, License & Edition (licence-gated items are now hidden, not greyed out).
- Upgrade and "Enterprise" badges: the Templates entry in the main sidebar, Templates in the
  space menu, Base and Kanban in the slash menu and the toolbar's More inserts, Resolve comment
  in the comment menu, Word in the export formats, Attachments in the search filter, DOCX, PDF
  and Confluence in the import dialog, the Security tab of space settings, the templates and
  personal-space switches of workspace settings.
- The page header's **Share** now opens core's share popover (share to web, include sub-pages,
  search indexing, link to open) instead of the Enterprise permission dialog.

Sources (fetched 2026-11-09): https://docmost.com/pricing, https://docmost.com/docs,
https://docmost.com/docs/editions, https://docmost.com/docs/user-guide/authentication,
https://docmost.com/docs/user-guide/ai, https://docmost.com/docs/user-guide/mcp,
https://docmost.com/docs/user-guide/audit-logs, https://docmost.com/docs/user-guide/import-export.
Feature names not described there (enforce SSO, personal spaces, viewer comments, retention,
public space appearance, OAuth apps' admin side) come from core's licence keys
(`apps/server/src/common/features.ts`) and core's UI labels.
