/**
 * runAll.ts — orchestrate the full benchmark in one go.
 *
 *   1. inspect    — environment sanity check (read-only)
 *   2. setup      — create sibling tables, apply schema changes (idempotent)
 *   3. benchRead  — read latency benchmark
 *   4. benchWrite — write throughput benchmark
 *   5. teardown   — drop sibling tables (skipped when KEEP_BENCH_TABLES=true)
 *
 * Each phase is executed in a child process so failures are isolated and
 * the user can re-run individual phases by name.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { config } from './lib/config.js';
import { log } from './lib/logger.js';

interface Phase {
    name: string;
    script: string;
}

const phases: Phase[] = [
    { name: 'inspect', script: 'src/inspect.ts' },
    { name: 'setup', script: 'src/setup.ts' },
    { name: 'benchRead', script: 'src/benchRead.ts' },
    { name: 'benchWrite', script: 'src/benchWrite.ts' },
];

if (!config.keepBenchTables) {
    phases.push({ name: 'teardown', script: 'src/teardown.ts' });
}

async function main(): Promise<void> {
    log.step('runAll — full pipeline');
    for (const phase of phases) {
        log.step(`Phase: ${phase.name}`);
        await runScript(phase.script);
    }
    log.step('All phases completed');
    if (config.keepBenchTables) {
        log.info('KEEP_BENCH_TABLES=true → sibling tables left in place. Run `npm run teardown` to drop them.');
    }
}

function runScript(script: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const fullPath = path.resolve(process.cwd(), script);
        const child = spawn('npx', ['tsx', fullPath], {
            stdio: 'inherit',
            shell: false,
            env: process.env,
        });
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`${script} exited with code ${code}`));
        });
    });
}

main().catch(err => {
    log.error(err.message);
    process.exit(1);
});
