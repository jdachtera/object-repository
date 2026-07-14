/**
 * Hybrid Logical Clock (ARCHITECTURE.md §9): a per-replica clock that combines physical time with
 * a counter so edits from different devices have a stable causal order even within the same
 * millisecond. Timestamps are formatted as fixed-width, lexicographically sortable strings, so
 * conflict resolution can compare them with plain `<`/`>`.
 */
export class HybridLogicalClock {
  private lastPhysical = 0;
  private counter = 0;

  constructor(private readonly nodeId: string) {}

  /** Produce a new timestamp for a local event. */
  now(): string {
    const physical = Date.now();
    if (physical > this.lastPhysical) {
      this.lastPhysical = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return format(this.lastPhysical, this.counter, this.nodeId);
  }

  /** Advance the clock to account for a timestamp received from another replica. */
  update(remote: string): void {
    const parsed = parse(remote);
    // A malformed remote stamp (non-numeric physical/counter — e.g. a hostile or buggy peer over the
    // sync API) must not poison the clock: `Math.max(x, NaN)` is `NaN`, which would pin `lastPhysical`
    // to NaN permanently and corrupt every future timestamp. Ignore it and keep our own time.
    if (!Number.isFinite(parsed.physical) || !Number.isFinite(parsed.counter)) return;
    const physical = Date.now();
    const maxPhysical = Math.max(physical, this.lastPhysical, parsed.physical);

    if (maxPhysical === this.lastPhysical && maxPhysical === parsed.physical) {
      this.counter = Math.max(this.counter, parsed.counter) + 1;
    } else if (maxPhysical === this.lastPhysical) {
      this.counter += 1;
    } else if (maxPhysical === parsed.physical) {
      this.counter = parsed.counter + 1;
    } else {
      this.counter = 0;
    }
    this.lastPhysical = maxPhysical;
  }
}

const PHYSICAL_WIDTH = 15;
const COUNTER_WIDTH = 6;

function format(physical: number, counter: number, nodeId: string): string {
  return `${pad(physical, PHYSICAL_WIDTH)}:${pad(counter, COUNTER_WIDTH)}:${nodeId}`;
}

function parse(timestamp: string): { physical: number; counter: number } {
  const [physical, counter] = timestamp.split(":");
  return { physical: Number(physical), counter: Number(counter) };
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}
