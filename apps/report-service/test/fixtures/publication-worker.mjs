/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { openDatabase } from '../../src/database.ts';
import { GithubIssues } from '../../src/github.ts';
import { publishOne } from '../../src/publication.ts';
const config = JSON.parse(process.env.REPORT_PUBLICATION_TEST_CONFIG);
const endpoint = process.env.REPORT_PUBLICATION_TEST_ENDPOINT;
const db = openDatabase(config.databaseUrl);
const github = new GithubIssues(config, (input, init) => {
  const url = new URL(String(input));
  return fetch(endpoint + url.pathname + url.search, init);
});
try { await publishOne(db, github); }
catch (error) {
  console.error(error instanceof Error ? error.constructor.name : 'publication_worker_failed');
  process.exitCode = 1;
} finally { await db.end(); }
