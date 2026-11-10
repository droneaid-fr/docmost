# Notice: modified version of Docmost

This repository (`github.com/droneaid-fr/docmost`, branch `droneaid`) is a **modified
version of [Docmost](https://github.com/docmost/docmost)**. Trigub Technologies OÜ has
modified it since **2026-11-08**, to run DroneAid's knowledge base. The application keeps
the name Docmost; this build is not made or endorsed by the Docmost authors.

## Copyright and licences

| Part | Copyright | Licence |
|---|---|---|
| Upstream Docmost core (everything not listed below) | © Docmost contributors | GNU Affero General Public License, version 3 ("AGPL 3.0", as stated upstream); text in [`LICENSE`](LICENSE) |
| Our modifications and additions (see "Where our code lives") | © 2025–2026 Trigub Technologies OÜ, Tartu mnt 67/1-13b, Kesklinna linnaosa, Tallinn, Harju maakond, 10115, Estonia | GNU Affero General Public License, version 3 **or (at your option) any later version** (`AGPL-3.0-or-later`) |
| `apps/client/src/ee`, `apps/server/src/ee`, `packages/ee`, `packages/base-formula` | the Docmost authors | Docmost Enterprise Edition license (each directory's own `LICENSE`) |

The combined work as built and run is licensed under the AGPL-3.0. This program comes with
**no warranty**, to the extent permitted by law (AGPL-3.0 §§15–16).

### Enterprise directories

The four Enterprise-licensed directories above are present in the tree only because this
repository is a GitHub fork of `docmost/docmost`. They are unchanged, **not part of our
build or image** (`.dockerignore`, `pnpm-workspace.yaml` and the `@/ee` alias keep them out;
see `droneaid/README.md`, "Enterprise code is not built"), and **we grant no licence to
them**. Their own `LICENSE` files govern them. Core's `@/ee/...` imports resolve to our
stubs in `apps/client/src/droneaid/ee-stubs/`, written from core's call sites only.

## Where our code lives

- `droneaid/` (documentation, deploy, Docker, migration and Hermes tooling)
- `apps/server/src/droneaid/`, `apps/client/src/droneaid/`
- `packages/editor-ext/src/lib/droneaid/`
- database migrations whose file names contain `droneaid`
- tests under `*/droneaid/` and the `droneaid.json` locale files
- `.github/workflows/droneaid-deploy.yml`, this `NOTICE.md`
- small, marked edits to upstream files that register the above (module imports, routes,
  menu items, build configuration). `git log main..droneaid` and
  `git diff main...droneaid` list every change with its date; `main` mirrors upstream.

We do **not** add licence or copyright headers to each file; this notice covers every
file we added or modified.

Some of our code (the translation module, the sign-up rule matcher and the MCP database
tools) was first written by Filipp Trigub in DroneAid's fork of AFFiNE. It contains no
upstream AFFiNE code and is relicensed here under the AGPL-3.0-or-later.

## Source code of a running instance

Every page of a running instance (settings, sign-in pages, public share pages) links
"Source code (AGPL-3.0)" to `https://github.com/droneaid-fr/docmost/tree/<commit>`, the exact
commit the image was built from. The image carries the same commit in its
`org.opencontainers.image.revision` label, and contains `LICENSE` and this notice in `/app`.

## Trademarks

"Docmost" is the name of the upstream project and may be a trademark of its owners. The AGPL
grants no trademark rights; we use the name only to identify the software this is based on.
