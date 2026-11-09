import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DatabaseColumn,
  DatabaseRow,
  DatabaseViewState,
  applyView,
  isEmptyView,
  readView,
} from "@docmost/editor-ext";

/**
 * The sort and filter state a database view uses, and the rows it shows.
 *
 * Editors read and write the shared `view` attribute. Readers (read-only
 * editor, shared pages) start from it but keep their changes locally.
 *
 * A row this user adds while a sort or filter is active is "pinned": it is
 * shown right below the row it was added under (or at the end) whether or
 * not it matches, until the view changes. So a new empty row never vanishes
 * under a filter or jumps away under a sort.
 */

export interface Pin {
  rowId: string;
  /** Show below this row; null = at the end. */
  after: string | null;
}

export function displayRows(
  columns: DatabaseColumn[],
  rows: DatabaseRow[],
  view: DatabaseViewState,
  pins: Pin[],
): DatabaseRow[] {
  const shown = applyView(columns, rows, view);
  if (!pins.length) return shown;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pinned = new Set(pins.map((p) => p.rowId));
  const list = shown.filter((r) => !pinned.has(r.id));
  for (const pin of pins) {
    const row = byId.get(pin.rowId);
    if (!row) continue;
    const anchor = pin.after ? list.findIndex((r) => r.id === pin.after) : -1;
    if (anchor >= 0) list.splice(anchor + 1, 0, row);
    else list.push(row);
  }
  return list;
}

export function useViewState(
  storedRaw: unknown,
  editable: boolean,
  persist: (view: DatabaseViewState) => void,
) {
  const stored = useMemo(() => readView(storedRaw), [JSON.stringify(storedRaw ?? null)]);
  const [local, setLocal] = useState<DatabaseViewState | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);

  // Editors always see the shared view; a local one only exists read-only.
  useEffect(() => {
    if (editable) setLocal(null);
  }, [editable]);
  const view = !editable && local ? local : stored;
  const isLocal = !editable && local !== null;

  const viewKey = JSON.stringify(view);
  useEffect(() => setPins([]), [viewKey]);

  const setView = useCallback(
    (next: DatabaseViewState) => {
      if (editable) persist(next);
      else setLocal(next);
    },
    [editable, persist],
  );

  const pin = useCallback(
    (rowId: string, after: string | null) => {
      if (isEmptyView(view)) return;
      setPins((list) => [...list.filter((p) => p.rowId !== rowId), { rowId, after }]);
    },
    [viewKey],
  );

  return {
    view,
    setView,
    isLocal,
    resetLocal: () => setLocal(null),
    pins,
    pin,
  };
}
