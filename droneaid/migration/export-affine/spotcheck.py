#!/usr/bin/env python3
"""Spot-check a bundle against the live restored AFFiNE over its MCP endpoint.

    AFFINE_MCP_TOKENS='{"<workspaceId>": "aff_mcp_v1...."}' \
      ./spotcheck.py <bundle-dir> <workspaceId>/<docId> [...]

The tokens are human (non-agent) MCP credentials, so the fork's own tools see
every doc. Per doc it compares the bundle with read_document,
get_document_info, read_database (all rows) and, once per workspace,
list_folders. Exit code 1 when any check fails. Standard library only.
"""
import json
import os
import re
import sys
import urllib.request

BASE = os.environ.get("AFFINE_URL", "http://localhost:3010")
TOKENS = json.loads(os.environ.get("AFFINE_MCP_TOKENS", "{}"))


def call(ws, tool, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(f"{BASE}/api/workspaces/{ws}/mcp", data=body, headers={
        "Authorization": f"Bearer {TOKENS[ws]}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        out = json.load(res)
    if "error" in out:
        raise RuntimeError(f"{tool}: {out['error']}")
    return out["result"]["content"][0]["text"]


def norm(line):
    return re.sub(r"\s+", " ", line).strip()


def mcp_lines(md):
    """Text lines of read_document output, minus what the bundle encodes differently."""
    md = re.sub(r"<!-- This document contains blocks.*?-->", "", md, flags=re.S)
    md = re.sub(r"<img\s.*?/>", "", md, flags=re.S)
    return [norm(l) for l in md.splitlines() if norm(l)]


def empty(v):
    return v is None or v == "" or v is False or v == []


def check_doc(bundle, ws, doc_id, results):
    d = f"{bundle}/workspaces/{ws}/docs/{doc_id}"
    meta = json.load(open(f"{d}/doc.json"))
    body = open(f"{d}/body.md").read()
    extra = open(f"{d}/edgeless-notes.md").read() if meta.get("edgelessNotes") else ""
    mine = set(norm(l) for l in (body + "\n" + extra).splitlines())
    mcp = call(ws, "read_document", {"docId": doc_id})

    lines = mcp_lines(mcp)
    missing = [l for l in lines if l not in mine]
    # Inline LaTeX: the reader drops it, the bundle adds `$...$`; compare without it.
    mine_no_math = set(re.sub(r"\$[^$]+\$", "", l).replace("  ", " ").strip() for l in mine)
    missing = [l for l in missing if re.sub(r"\s+", " ", l) not in mine_no_math and l.replace(" ", "") not in {m.replace(" ", "") for m in mine_no_math}]
    imgs_mcp = sorted(set(re.findall(r'src="blob://([^"]+)"', mcp)))
    imgs_mine = sorted(set(re.findall(r"\]\(blob://([^)]+)\)", body + extra)))
    links_mcp = sorted(set(re.findall(r"\(affine://([A-Za-z0-9_-]+)\)", mcp)))
    dbs_mcp = sorted(re.findall(r"<!-- database id=([A-Za-z0-9_-]+)", mcp))
    info = json.loads(call(ws, "get_document_info", {"docId": doc_id}))
    r = {
        "doc": f"{meta['title']} ({doc_id})",
        "mcpTextLines": len(lines),
        "linesMissingInBundle": missing[:5],
        "missingCount": len(missing),
        "imagesMcp": len(imgs_mcp),
        "imagesBundle": len(imgs_mine),
        "imagesMatch": set(imgs_mcp) <= set(imgs_mine),
        "linksMatch": links_mcp == meta["links"]["affine"],
        "databasesMatch": dbs_mcp == sorted(x["id"] for x in meta["databases"]),
        "infoMatch": info["title"] == meta["title"] and info["mode"] == meta["mode"]
        and info["trashed"] == meta["trash"] and info["public"] == meta["publish"]["published"]
        and info["tags"] in ([t["name"] for t in meta["tags"]], [t["id"] for t in meta["tags"]]),
        "folders": {"mcp": info.get("folders"), "bundle": [[p["name"] for p in f["path"]] for f in meta["folders"]]},
    }
    r["foldersMatch"] = sorted(r["folders"]["mcp"] or []) == sorted(r["folders"]["bundle"])
    r["databases"] = [check_database(d, ws, doc_id, x["id"]) for x in meta["databases"]]
    r["ok"] = (r["missingCount"] == 0 and r["imagesMatch"] and r["linksMatch"] and r["databasesMatch"]
               and r["infoMatch"] and r["foldersMatch"] and all(x["ok"] for x in r["databases"]))
    results.append(r)


def check_database(doc_dir, ws, doc_id, db_id):
    mine = json.load(open(f"{doc_dir}/databases/{db_id}.json"))
    rows, offset = [], 0
    while True:
        page = json.loads(call(ws, "read_database", {"docId": doc_id, "databaseId": db_id, "offset": offset, "limit": 500}))
        rows += page["rows"]
        if "nextOffset" not in page:
            break
        offset = page["nextOffset"]
    names = [c["name"] for c in mine["columns"]]
    key = {c["id"]: (c["name"] if names.count(c["name"]) == 1 else c["id"]) for c in mine["columns"]}
    mapped = [{"id": r["id"], "values": {key[k]: v for k, v in r["values"].items() if not empty(v)}} for r in mine["rows"]]
    cols_ok = [{k: c[k] for k in ("id", "name", "type") } for c in page["columns"]] == [{k: c[k] for k in ("id", "name", "type")} for c in mine["columns"]]
    diffs = [m["id"] for m, r in zip(mapped, rows) if m != r]
    return {"databaseId": db_id, "title": mine["title"], "rowsMcp": len(rows), "rowsBundle": mine["rowCount"],
            "columns": len(mine["columns"]), "columnsMatch": cols_ok, "rowDiffs": diffs[:5],
            "ok": len(rows) == mine["rowCount"] and cols_ok and not diffs and len(mapped) == len(rows)}


def check_folders(bundle, ws):
    tree = json.loads(call(ws, "list_folders", {}))["folders"]
    mine = json.load(open(f"{bundle}/workspaces/{ws}/folders.json"))["tree"]
    strip = lambda ns: [{"id": n["id"], "name": n["name"], "folders": strip(n["folders"]),
                         "items": [(i["linkId"], i["type"], i["targetId"]) for i in n["items"]]} for n in ns]
    return {"workspace": ws, "foldersMatch": strip(tree) == strip(mine)}


def main():
    bundle, targets = sys.argv[1], sys.argv[2:]
    results = []
    for t in targets:
        ws, doc_id = t.split("/", 1)
        check_doc(bundle, ws, doc_id, results)
    folders = [check_folders(bundle, ws) for ws in sorted({t.split("/")[0] for t in targets})]
    print(json.dumps({"docs": results, "folders": folders}, indent=1, ensure_ascii=False))
    ok = all(r["ok"] for r in results) and all(f["foldersMatch"] for f in folders)
    print("SPOTCHECK", "PASSED" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
