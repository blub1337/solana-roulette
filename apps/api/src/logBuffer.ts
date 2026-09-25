/**
 * In-memory ring buffer of the redacted transaction log.
 *
 * The admin console needs a live tail of deposits, payouts and failures without
 * shipping raw log files to a browser. `txLog` pushes every line here AFTER
 * redaction, so nothing secret can enter the buffer in the first place.
 *
 * The buffer is per-process and bounded: it is an observability aid, not an
 * audit store. The durable record is the PostgreSQL mirror
 * (`chain_transactions`, `failures`).
 */

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

export interface LogQuery {
  /** "error" also returns "warn" entries. */
  level?: "info" | "warn" | "error";
  /** Substring match against the event name. */
  event?: string;
  limit?: number;
}

const LEVEL_WEIGHT: Record<LogEntry["level"], number> = { info: 0, warn: 1, error: 2 };

export class LogRing {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly capacity = 500) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Newest first, already filtered and bounded. */
  list(query: LogQuery = {}): LogEntry[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), this.capacity);
    const min = query.level ? LEVEL_WEIGHT[query.level] : 0;
    const needle = query.event?.trim().toLowerCase();
    const out: LogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.entries[i]!;
      if (LEVEL_WEIGHT[entry.level] < min) continue;
      if (needle && !entry.event.toLowerCase().includes(needle)) continue;
      out.push(entry);
    }
    return out;
  }
}

/** Process-wide buffer fed by `txLog`. */
export const logRing = new LogRing(500);
