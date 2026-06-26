#!/usr/bin/env node

/**
 * Runs `changeset version` with retry/backoff to survive transient GitHub
 * API failures during changelog generation.
 *
 * `@changesets/changelog-github` fetches PR + author metadata from
 * https://api.github.com/graphql to build each changelog entry. That call
 * occasionally dies mid-flight with errors like:
 *
 *   Failed to parse data from GitHub
 *   Invalid response body while trying to fetch
 *   https://api.github.com/graphql: Premature close
 *
 * which aborts the whole `changeset version` step and fails the Release
 * workflow (e.g. run 28263520541). The failure is purely a network blip on
 * GitHub's side — nothing in our repo is wrong.
 *
 * `changeset version` is transactional: when changelog generation throws it
 * "escapes applying the changesets, and no files are affected", so re-running
 * is safe. Each attempt is a fresh child process, which also resets the
 * `@changesets/get-github-info` GraphQL DataLoader (it caches rejected
 * promises for the process lifetime, so retrying in-process would just
 * replay the cached failure). Spawning anew is what lets a retry actually
 * reach the network again.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 2000; // 2s, 4s, 8s — matches the repo's git retry policy

/** Block for `ms` milliseconds without pulling in async/timers. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// Resolve the changeset CLI from node_modules so this does not depend on
// node_modules/.bin being on PATH.
const changesetBin = require.resolve('@changesets/cli/bin.js');

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = spawnSync(process.execPath, [changesetBin, 'version'], {
    stdio: 'inherit',
  });

  if (result.status === 0) {
    process.exit(0);
  }

  // spawn itself failed (binary missing, etc.) — not a retryable network blip.
  if (result.error) {
    console.error(`changeset version could not be spawned: ${result.error.message}`);
    process.exit(1);
  }

  if (attempt < MAX_ATTEMPTS) {
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    console.error(
      `changeset version failed (exit ${result.status}) on attempt ${attempt}/${MAX_ATTEMPTS}; ` +
        `retrying in ${delay / 1000}s (likely a transient GitHub API error during changelog generation).`,
    );
    sleepSync(delay);
  } else {
    console.error(
      `changeset version failed after ${MAX_ATTEMPTS} attempts (exit ${result.status}).`,
    );
    process.exit(result.status ?? 1);
  }
}
