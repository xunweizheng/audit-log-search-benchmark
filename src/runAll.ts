/**
 * runAll.ts — orchestrate the full benchmark in one process.
 *
 *   1. inspect    — environment sanity check (read-only)        [child process]
 *   2. setup      — create sibling tables, apply schema changes [child process]
 *   3. benchRead  — read latency benchmark                      [in-process]
 *   4. benchWrite — write throughput benchmark                  [in-process]
 *   5. combine    — merge read + write reports into one         [in-process]
 *   6. teardown   — drop sibling tables (skipped when KEEP_BENCH_TABLES=true)
 *                                                               [child process]
 *
 * Steps 1, 2 and 6 are run as child processes so a failure in one of them
 * doesn't leave the parent connection pool in an inconsistent state. Steps
 * 3–5 are run in-process so we can keep the read and write `BenchReport`
 * objects in memory and merge them directly.
 *
 * Each phase still has its own dedicated npm script (npm run bench:read /
 * bench:write / inspect / setup / teardown) for when you want to re-run
 * just one piece.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { runReadBenchmark } from './benchRead.js';
import { runWriteBenchmark } from './benchWrite.js';
import { config } from './lib/config.js';
import { closeConnection } from './lib/db.js';
import { log } from './lib/logger.js';
import { mergeReports, writeReport } from './lib/report.js';

async function runChildScript(script: string): Promise<void> {
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

async function main(): Promise<void> {
    log.step('runAll — full pipeline');

    // Phase 1: inspect (child process — read-only, isolated)
    log.step('Phase: inspect');
    await runChildScript('src/inspect.ts');

    // Phase 2: setup (child process — DDL, isolated)
    log.step('Phase: setup');
    await runChildScript('src/setup.ts');

    // Phases 3+4: read & write benchmarks (in-process so we can merge)
    log.step('Phase: benchRead');
    const readReport = await runReadBenchmark();

    log.step('Phase: benchWrite');
    const writeReport2 = await runWriteBenchmark();

    // Phase 5: combine the two reports
    log.step('Phase: combine');
    const combined = mergeReports(readReport, writeReport2);
    const outDir = path.resolve(process.cwd(), 'reports');
    const paths = await writeReport(combined, outDir, 'combined');
    log.sub(`Markdown : ${paths.md}`);
    log.sub(`JSON     : ${paths.json}`);
    log.sub(`CSV      : ${paths.csv}`);

    // Close any connection re-used by the in-process phases before spawning
    // a child for teardown.
    await closeConnection();

    // Phase 6: teardown (optional, child process)
    if (!config.keepBenchTables) {
        log.step('Phase: teardown');
        await runChildScript('src/teardown.ts');
    } else {
        log.info(
            'KEEP_BENCH_TABLES=true → sibling tables left in place. Run `npm run teardown` to drop them.'
        );
    }

    log.step('All phases completed');
}

main().catch(err => {
    log.error(err.message);
    process.exit(1);
});
