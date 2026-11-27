// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('./install-valgrind.sh', import.meta.url));

test('#11722 Valgrind setup restricts both apt operations and propagates failures', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'valgrind-apt-test-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sudo'), `#!/usr/bin/env bash
printf '%s\\n' "$*"
[[ "$6" != "$FAIL_APT_OPERATION" ]]
`, { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const apt = 'apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-';
  const update = `${apt} update\n`;
  const install = `${apt} install -y --no-install-recommends valgrind\n`;
  for (const [failure, status, stdout] of [
    ['', 0, update + install],
    ['update', 1, update.repeat(3)],
    ['install', 1, (update + install).repeat(3)],
  ]) {
    const run = spawnSync('bash', ['-e', installer], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAIL_APT_OPERATION: failure },
      encoding: 'utf8',
    });
    assert.equal(run.status, status, run.stderr);
    assert.equal(run.stdout, stdout);
  }
});
