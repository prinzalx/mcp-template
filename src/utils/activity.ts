/** One finished tool call, as the dashboard shows it. */
export interface ActivityEntry {
  at: string;
  tool: string;
  ok: boolean;
  duration_ms: number;
  origin: string;
  summary: string;
}

export interface Activity {
  add(entry: ActivityEntry): void;
  recent(n: number): ActivityEntry[];
}

/** In-memory ring buffer; the dashboard polls it, nothing is persisted. */
export function createActivity(capacity = 200): Activity {
  const ring: ActivityEntry[] = [];
  return {
    add(entry) {
      ring.push(entry);
      if (ring.length > capacity) ring.shift();
    },
    recent(n) {
      return ring.slice(-n).reverse();
    },
  };
}
