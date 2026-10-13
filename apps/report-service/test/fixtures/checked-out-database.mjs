/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { openDatabase, transaction } from '../../src/database.ts';

let release;
const interrupted = new Promise(resolve => { release = resolve; });
let notifications = 0;
const db = openDatabase(process.env.REPORT_TEST_DATABASE_URL, () => {
  notifications++;
  process.exitCode = 1;
  release();
});
try {
  if (process.env.OWN_DATABASE_MODE === 'idle') {
    const client = await db.connect();
    const result = await client.query('SELECT pg_backend_pid() AS pid');
    client.release();
    process.send({ ready: true, pid: result.rows[0].pid, idleCount: db.idleCount });
    await interrupted;
  } else {
    let rejected = false;
    try {
      await transaction(db, async client => {
        const result = await client.query('SELECT pg_backend_pid() AS pid');
        // PostgreSQL sees an idle transaction, while pg-pool still has the
        // client checked out. This await is a real transaction callback gap.
        process.send({ ready: true, pid: result.rows[0].pid, idleCount: db.idleCount });
        await interrupted;
      });
    } catch {
      // Expected query/COMMIT rejection is observed separately from the event;
      // do not leak the driver's private error object into subprocess output.
      rejected = true;
    }
    process.send({ rejected });
  }
} finally {
  await db.end();
  process.send({ notifications });
}
