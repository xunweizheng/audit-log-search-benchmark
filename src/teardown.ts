/**
 * teardown.ts — drop all sibling bench tables.
 * Safe to run multiple times; missing tables are ignored.
 */
import { closeConnection, getConnection, tableExists } from './lib/db.js';
import { log } from './lib/logger.js';
import { schemes } from './lib/schemes.js';

async function main(): Promise<void> {
    log.step('Teardown sibling bench tables');
    const conn = await getConnection();
    for (const scheme of schemes) {
        if (await tableExists(scheme.table)) {
            log.info(`Dropping ${scheme.table} ...`);
            await conn.query(`DROP TABLE ${scheme.table}`);
        } else {
            log.sub(`${scheme.table} does not exist — skipping`);
        }
    }
    log.info('Teardown complete.');
    await closeConnection();
}

main().catch(err => {
    log.error(err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
