const stamp = (): string => new Date().toISOString();

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
    step: (msg: string): void => {
        console.log(`\n=== ${msg} ===`);
    },
    sub: (msg: string): void => {
        console.log(`  • ${msg}`);
    },
};
