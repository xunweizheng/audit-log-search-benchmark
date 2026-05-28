/**
 * Local-time timestamped console logger.
 *
 * We deliberately format the timestamp in the host's local timezone with
 * millisecond precision (e.g. "2026-05-27 19:46:30.123") rather than ISO 8601
 * UTC, because the primary audience for these logs is a developer reading
 * terminal output during a benchmark run — local wall-clock time is what
 * lets you correlate output with what's happening on your screen.
 *
 * Every variant (info / warn / error / step / sub) prepends a timestamp so
 * timing information is consistently available; previously step / sub did
 * not, which made it hard to tell when long-running phases actually started.
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad3 = (n: number): string => String(n).padStart(3, '0');

const stamp = (): string => {
    const d = new Date();
    return (
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
    );
};

export const log = {
    info: (msg: string, ...args: unknown[]): void => {
        console.log(`[${stamp()}] ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]): void => {
        console.warn(`[${stamp()}] WARN  ${msg}`, ...args);
    },
    error: (msg: string, ...args: unknown[]): void => {
        console.error(`[${stamp()}] ERROR ${msg}`, ...args);
    },
    /**
     * Section header. Adds a blank line above and timestamps the heading so
     * "when did this phase start" is obvious in the terminal scrollback.
     */
    step: (msg: string): void => {
        console.log(`\n[${stamp()}] === ${msg} ===`);
    },
    /**
     * Indented sub-bullet. Also timestamped so progress lines inside a loop
     * are easy to correlate with later events.
     */
    sub: (msg: string): void => {
        console.log(`[${stamp()}]   • ${msg}`);
    },
};
