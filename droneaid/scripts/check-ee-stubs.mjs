// Checks that every `@/ee/...` import in the client's core code is served by our
// stub tree (apps/client/src/droneaid/ee-stubs), which the `@/ee` alias points at.
// It never reads apps/client/src/ee (Docmost Enterprise License, clean room).
// Usage: node droneaid/scripts/check-ee-stubs.mjs [--quiet]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientDir = path.join(repoRoot, "apps/client");
const srcDir = path.join(clientDir, "src");
const eeDir = path.join(srcDir, "ee");
const stubDir = path.join(srcDir, "droneaid/ee-stubs");
const ts = createRequire(path.join(clientDir, "package.json"))("typescript");
const quiet = process.argv.includes("--quiet");

const SOURCE_EXT = /\.(ts|tsx)$/;
const DOC_LINE = /^\/\/ Core expects: \S/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Never descend into the Enterprise tree or into our stubs.
    if (full === eeDir || full === stubDir || entry.name === "node_modules") continue;
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(file) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// key "<spec without extension>" -> { spec, names:Set, users:Set }
const required = new Map();
const errors = [];

function need(spec, name, file) {
  const key = spec.replace(SOURCE_EXT, "");
  if (!required.has(key)) required.set(key, { spec, names: new Set(), users: new Set() });
  const entry = required.get(key);
  if (name) entry.names.add(name);
  entry.users.add(path.relative(repoRoot, file));
}

function classify(spec, file, names) {
  if (spec.startsWith("@/ee/")) {
    if (names.length === 0) need(spec, null, file);
    for (const n of names) need(spec, n, file);
    return;
  }
  if (spec.startsWith(".")) {
    const target = path.resolve(path.dirname(file), spec);
    if (isInside(target, eeDir)) {
      errors.push(`${path.relative(repoRoot, file)}: relative import "${spec}" reaches src/ee; use "@/ee/..." so the alias serves a stub`);
    }
  }
}

for (const file of walk(srcDir)) {
  const sf = parse(file);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = [];
      if (ts.isImportDeclaration(node) && node.importClause) {
        const clause = node.importClause;
        if (clause.name) names.push("default");
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
        }
      }
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
      }
      classify(node.moduleSpecifier.text, file, names);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const spec = node.arguments[0].text;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // import("x") used as a lazy component needs a default export; import("x").then(...) picks its own.
        const parent = node.parent;
        const chained = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node;
        classify(spec, file, chained ? [] : ["default"]);
      } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(sf) === "vi.mock") {
        classify(spec, file, []);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function resolveStub(spec) {
  const rel = spec.slice("@/ee/".length);
  const base = path.join(stubDir, rel);
  const candidates = SOURCE_EXT.test(rel)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set();
  const sf = parse(file);
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isExportAssignment(st)) names.add("default");
    if (exported && isDefault) names.add("default");
    if (exported && !isDefault) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
      } else if (st.name && ts.isIdentifier(st.name)) {
        names.add(st.name.text);
      }
    }
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add(el.name.text);
      } else if (!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = resolveRelative(file, st.moduleSpecifier.text);
        if (target) for (const n of exportsOf(target, seen)) if (n !== "default") names.add(n);
      }
    }
  }
  return names;
}

function resolveRelative(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(
    (c) => fs.existsSync(c) && fs.statSync(c).isFile(),
  );
}

const rows = [...required.values()].sort((a, b) => a.spec.localeCompare(b.spec));
for (const { spec, names, users } of rows) {
  const stub = resolveStub(spec);
  const wanted = [...names].sort();
  if (!quiet) console.log(`${spec}  { ${wanted.join(", ") || "(module only)"} }  <- ${users.size} file(s)`);
  if (!stub) {
    errors.push(`missing stub module for "${spec}" (used by ${[...users].join(", ")})`);
    continue;
  }
  const firstLine = fs.readFileSync(stub, "utf8").split("\n", 1)[0];
  if (!DOC_LINE.test(firstLine)) {
    errors.push(`${path.relative(repoRoot, stub)}: first line must be a "// Core expects: ..." comment`);
  }
  const have = exportsOf(stub);
  for (const n of wanted) {
    if (!have.has(n)) errors.push(`"${spec}" lacks export "${n}" (used by ${[...users].join(", ")})`);
  }
}

if (errors.length) {
  console.error(`\ncheck-ee-stubs: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-ee-stubs: OK, ${rows.length} @/ee modules served by apps/client/src/droneaid/ee-stubs`);
