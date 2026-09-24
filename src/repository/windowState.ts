/**
 * Which compatibility windows have closed — the one predicate provisioning, the Repository and the
 * migration runner all consult (ARCHITECTURE.md §13).
 *
 * A window is closed when the contract that ends it has run: the rename's `dropField` of the legacy
 * field is journalled as applied (or the rename ran whole, which never opened a window at all). Not
 * when the floor is raised. Between raising the floor and releasing the contract the legacy field is
 * still the authoritative copy: the release's re-copy is what makes the canonical field current. Any
 * layer deciding "closed" earlier stops writing the legacy field that the release is about to copy
 * from, and any layer deciding it later keeps mirroring into a field that no longer exists. So every
 * layer asks this, and nothing else.
 */
import type { JournalRow } from "../migrations/journal.ts";

const key = (model: string, legacy: string): string => `${model}\0${legacy}`;

export class WindowState {
  private closed = new Set<string>();
  private generation = 0;
  /** Settles once the store's journal has been read; until then every declared window counts as open. */
  ready: Promise<void> = Promise.resolve();
  /**
   * False while the journal is being read. A model declaring a window is neither registered nor written
   * until then: registered with every window open, a SQL store would re-create a legacy column a
   * released contract dropped, and a write would put values back into it.
   */
  known = true;

  isClosed(model: string, legacy: string): boolean {
    return this.closed.has(key(model, legacy));
  }

  /** Bumped on every change, so a consumer can cache what it derived from the state. */
  get version(): number {
    return this.generation;
  }

  /** Replace the known state. Returns the models whose windows changed. */
  update(rows: JournalRow[]): Set<string> {
    const next = closedWindows(rows);
    const changed = new Set<string>();
    for (const entry of new Set([...next, ...this.closed])) {
      if (next.has(entry) !== this.closed.has(entry)) changed.add(entry.split("\0")[0]!);
    }
    this.closed = next;
    if (changed.size) this.generation += 1;
    return changed;
  }
}

/** The windows the journal says have closed: `model\0legacyField`. */
export function closedWindows(rows: JournalRow[]): Set<string> {
  const closed = new Set<string>();
  for (const row of rows) {
    if (row.status !== "applied") continue;
    for (const op of row.ops) {
      if (op.kind === "dropField" && op.closes) closed.add(key(op.model, op.field));
      if (op.kind === "renameField") closed.add(key(op.model, op.from));
    }
  }
  return closed;
}
