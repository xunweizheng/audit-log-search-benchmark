export interface Stats {
    count: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
}

/**
 * Compute basic latency statistics from a list of millisecond samples.
 * Samples are not mutated.
 */
export function computeStats(samples: number[]): Stats {
    if (samples.length === 0) {
        return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, n) => acc + n, 0);
    const pct = (p: number): number => {
        // index = floor(p * length), clamped to last index
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx];
    };
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / sorted.length,
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
    };
}

/**
 * Run an async function `iterations` times after `warmup` warmup calls.
 * Each measured call is timed with hrtime nanosecond precision.
 * Returns the array of latencies in milliseconds.
 */
export async function timeRepeated(
    fn: () => Promise<unknown>,
    iterations: number,
    warmup: number
): Promise<number[]> {
    for (let i = 0; i < warmup; i++) {
        // Discard timing — purpose is to load InnoDB buffer pool / parser cache.
        await fn();
    }
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = process.hrtime.bigint();
        await fn();
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
    }
    return samples;
}

export function fmtMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 1) return `${ms.toFixed(1)}ms`;
    return `${ms.toFixed(3)}ms`;
}
