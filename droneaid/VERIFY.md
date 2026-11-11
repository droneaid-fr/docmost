# Manual verification checklist

For the local verification stack (README, "Local verification stack"): http://localhost:3000,
signed in as `filipp@droneaid.fr` with `LOCAL_FILIPP_PASSWORD` from `droneaid/local/.env`.
Mail: http://localhost:8025. Page links below are those of the S7 import (2026-11-09); a
re-import gives new page ids, so find the page by title instead.

Tick each line; anything unexpected goes into the Phase 7 notes.

## Sign-in and access (S1, S2a, S2b)

- [ ] **Login page**: open http://localhost:3000/login in a private window → email and password form only, no "Continue with Google" (Google is not configured locally).
- [ ] **Password sign-in**: sign in as filipp → Home lists recent pages; sidebar space menu shows DroneAid France, DroneAid Academy and DroneAid R&D (no General, no Demo Workspace since S12).
- [ ] **Password reset mail**: log out → *Forgot your password?* → any imported email (e.g. `emmanuel@droneaid.fr`) → the mail appears in mailpit; its link sets a password; that user then sees only their own spaces (DroneAid France).
- [ ] **Signup rules**: Settings → *Signup rules* → 4 rules (`droneaid.fr`, `gey.olivier@gmail.com`, `yildirim.serhat62@gmail.com` → DroneAid France writer; `anton.chaika@drone-aid.pt` → DroneAid R&D admin), Google signup switch on. Edit a pattern → the preview line updates; Save works; reload keeps it.
- [ ] **Space roles**: Space settings → Members of each space → AFFiNE owners/admins are admins, members writers; "Everyone" is not a member of any migrated space.
- [x] *Resolved (S12)*: **Demo Workspace** is not migrated (local-only AFFiNE workspace, one member `mark.p@drone-aid.nl`). The importer leaves it out by default (`--exclude-workspaces`, default `Demo Workspace`): no space, pages, files or import-map rows; its old URLs fall through to `/home`. `import-report.md` → *Workspaces not migrated* lists what was dropped (8 docs, 1 folder, 1 database, 19 files / 783,408 B, 42 old URLs). `mark.p` still gets a Docmost account, with no space.
- [x] *Resolved (S12)*: **General** (Docmost's default space) is deleted by the importer right after setup; `workspaces.default_space_id` is null. Core only writes that column (signup, invitations and our Google signup never read it), so new users land on Home with the spaces their signup rule or invitation groups give them. `verify.md` checks it (`default "General" space` 0).
- [x] *Resolved (S12)*: **Batteries** (DroneAid Academy) had members at editor instead of manager in AFFiNE; here they get their space role. Confirmed acceptable, no change.
- [ ] Not testable locally: Google sign-in (mock-OIDC e2e 15/15 passed in S7; needs the redirect URI on the real client), and the missing "invite accepted" mail on the Google-invite path (S2b open issue).
- [ ] Known: no MFA in this build (EE); password login never asks for a second factor.

## Pages, content and migration (S6)

- [ ] **Page trees**: each space's sidebar mirrors the AFFiNE folders (folders became pages; docs in a folder are their children; order as in AFFiNE's sidebar). DroneAid France: Reports, Outreach, Participants, Workshops, About, then loose docs.
- [ ] **Images**: *DroneAid Collective R&D Track Record* (`/s/droneaid-r-and-d/p/x-UWJmEP4j0s`) → 8 images load; click one → it opens full size.
- [ ] **LaTeX**: *Getting Started* in DroneAid France (`/s/droneaid-france/p/x-zVeGE18sXJ`) → 8 formulas render (KaTeX).
- [ ] **Internal links**: in any doc that linked another AFFiNE doc, click the link → the Docmost page opens (30 links converted, 0 `affine://` left).
- [ ] **Comments**: *zz MCP test A renamed* (DroneAid France) → comment panel shows the imported comment and its reply.
- [ ] **Trash**: space menu → Trash → 36 trashed AFFiNE docs; restore one → it returns to the tree. *Judge*: Docmost purges trash after 30 days; restore any doc that must be kept.
- [ ] **Opening a page changes nothing**: open a few imported pages, close them, then Page history → no new version from just opening.
- [ ] **Search** (French config, S3c): search a word from a French page in another form (plural, feminine, without accents) → the page is found.
- [ ] **Version history**: edit a page, wait ~1 minute → Page history lists the version; restore works.
- [ ] Known: canvas-only AFFiNE drawings are dropped; canvas text appears under "Canvas notes" (4 "Getting Started" templates only).

## Databases (S4a, S4b)

- [ ] **Target List** (`/s/droneaid-france/p/target-list-2DIKAKhhgX`): two databases (*French defence companies*, *french_defence_companies*), each "777 rows", 8 columns, smooth scrolling. *Judge*: the duplicate came from AFFiNE; delete one?
- [ ] **Sort**: Sort → Add sort → Exposant, Descending → first row ZHENDRE; add a second sort; Clear all restores the original order.
- [ ] **Filter**: Filter → Add filter → Exposant contains `AERO` → "10 of 777 rows"; try a select/date filter; Clear all.
- [ ] Sorts and filters are shared with every viewer (stored in the page): clear them after testing.
- [ ] **Edit a cell**: double-click a text cell → type → Enter → value kept after reload; Esc cancels.
- [ ] **Select cells**: click a select/multi-select cell → dropdown of options; add a new option; colours shown as pills.
- [ ] **Columns**: column header menu → rename, change type (a warning lists values that would be lost), move left/right, resize by dragging, delete; add a column with "+".
- [ ] **Rows**: New row; row handle → insert below / delete; select several rows → delete; drag a row (only without a sort).
- [ ] **Keyboard**: arrows move between cells, Enter edits, Esc leaves.
- [ ] **Paste**: copy the whole database block and paste it in another page → an independent copy (editing one leaves the other unchanged).
- [ ] **Two browsers**: open Target List in two browsers (or a normal and a private window, signed in as two users), edit different cells at the same time → both edits appear in both within a second.
- [ ] *Judge* (S4b open issues): moving a row while someone else edits the same row drops that edit; an edit made ~150 ms before closing the tab may be lost.
- [ ] **Participant list** (`/s/droneaid-france/p/participant-list-Yn1KNHb2W8`): *Guests* "201 rows", 23 columns. *Judge*: 5 columns hidden in AFFiNE are shown here (Docmost databases have no hidden columns).
- [ ] **Markdown export**: page menu → Export → Markdown → the database comes out as a table.

## Public sharing and translation (S5)

- [ ] **Shares**: the 6 AFFiNE-published docs are shared (page header shows it). Private window → http://localhost:3000/share/oudywxte41/p/how-to-use-folder-and-tags-BxsPs1tIHj → the page renders without sign-in.
- [ ] **`?lang=`**: same URL with `?lang=fr` → French text (imported, real AFFiNE translation), language menu at the top; the browser tab title is French. Unknown `?lang=xx` → original.
- [ ] *Judge*: the server sends `<html lang="fr">`, but the app then resets it to the UI language (minor, affects screen readers and SEO only).
- [ ] **Translations panel**: on a shared page, the **Translations** button beside Share → pick a target language (e.g. DE) → within ~30 s its status turns ready → `?lang=de` shows the text tagged ` [fake-de]` (fake Gemini; README says how to use a real key).
- [ ] **Out of date**: edit the shared page → `?lang=fr` shows the original at once; after ~10 minutes without edits it is translated again (or press **Update translations**).
- [ ] **Unshare** the page → within 30 s its translations disappear (the language menu goes).
- [ ] **Read-only database on a share**: share a page with a database → in the private window, sort/filter it → only your view changes, nothing is saved.

## Agent and MCP (S3a, S3b, S3c, S4c)

- [ ] **Agents page**: Settings → *Agents* → *DroneAid France agent*, writer in DroneAid France, one token "S7 local test profile"; create and revoke a token.
- [ ] **Test agent** (terminal): `hermes -p da-france-docmost-test -z "Search for 'Target List' and tell me how many rows its database has."` → 777 (two identical databases).
- [ ] **Write over MCP**: ask the test agent to create a doc in DroneAid France with a heading and a table → it appears in the tree; open it while the agent appends a line → the line arrives live. *Judge*: the sidebar may need a reload to show new children (S3b open issue).
- [ ] **Database over MCP**: ask the agent to add a row to *Already approached* (`/s/droneaid-france/p/x-dXJoDITiIQ`) and change a cell → visible in the open page without reload.
- [ ] **Blacklist rule**: ask the test agent to list the guests of *Participant list* it may email → blacklisted guests are left out (the test profile's `SOUL.md` points at the imported page `Yn1KNHb2W8`; production needs the same id swap at cutover).
- [ ] **PDF import**: ask the test agent to import a small PDF → a new page with text and images; the reply links to `http://localhost:3000/...`.
- [ ] **Read-only elsewhere**: ask the agent to edit a page in DroneAid Academy → refused (it has no access there).
- [ ] Known: unused uploads from `upload_image` are not cleaned up (S3b).

## Personal MCP tokens (S9)

- [ ] **Page**: as a plain member, Settings → Account → *MCP tokens* shows the endpoint `<APP_URL>/api/droneaid/mcp` with a Copy button. *Create token* (name, expiry 90 days) → the token is shown once with an example `mcpServers` JSON and a `claude mcp add` command; closing the dialog leaves only its prefix in the list.
- [ ] **Use it**: add the JSON to an MCP client (or `curl` `tools/list` with `Authorization: Bearer dmcpu_...`) → `list_documents` shows only spaces the member is in; `create_document` in a space where they are a reader is refused; in a space where they write it works and the page's author is the member. *Last used* fills in.
- [ ] **Not a login**: `POST /api/users/me` with the same bearer → 401.
- [ ] **Revoke** in the list → the client gets 401 at once.
- [ ] **Deactivate** the member (Settings → Members) → their token gets 401; reactivate → it works again.
- [ ] **Cap**: an 11th live token is refused ("You already have 10 active tokens"); *Create token* is disabled at 10.
- [ ] **Agents**: an agent account has no *MCP tokens* item; the API answers 403 to its create call.

## Enterprise code removed (S8)

- [ ] **Settings sidebar**: Account shows Profile and Preferences; Workspace shows General, Members, Groups, Spaces, Public sharing, Integrations, Agents, Sign-up rules. No API keys, Security & SSO, Verified pages, API management, AI settings, Audit logs or License & Edition; `/settings/security` shows the 404 page.
- [ ] **Share**: the page header's Share opens a small popover (Share to web, link with copy and open, Include sub-pages, Search engine indexing). Turning it on makes **Translations** appear beside it at once; turning it off hides it.
- [ ] **No upgrade prompts**: the slash menu has Database but no Base or Kanban; the import dialog has no DOCX, PDF or Confluence; the export dialog has no Word; the comment menu has no Resolve; the space menu has no Templates.
- [ ] Known: an embedded Docmost Base (none among the migrated pages) shows "Base is not available in this edition."

## Images and deployment (S1, S7)

- [ ] `docker images | grep docmost-droneaid` → `local` (amd64) and `local-arm64` exist; the stack runs `docmost-droneaid:local`.
- [ ] Old AFFiNE URLs (checked in S7 with `caddy:2` and `redirects.caddy`): a doc URL → 301 to its page; a published doc with `?lang=fr` → 301 to its share with `?lang=fr`; `/invite/...` → `/login`; unknown `/workspace/...` → `/home`.
