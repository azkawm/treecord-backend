/** In-memory counters and gauges, served as JSON on GET /metrics. Reset on restart. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  readonly startedAt = new Date();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  snapshot(): {
    startedAt: string;
    uptimeSec: number;
    counters: Record<string, number>;
    gauges: Record<string, number>;
  } {
    const sorted = (map: Map<string, number>) =>
      Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      counters: sorted(this.counters),
      gauges: sorted(this.gauges),
    };
  }
}
