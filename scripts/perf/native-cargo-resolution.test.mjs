/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, realpathSync,
  renameSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCanonicalCargoShim, verifyCanonicalCargoResolution } from './native-cargo-resolution.mjs';
import { sameNativeFile } from './native-file-identity.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function fixture(t, run) {
  const tools = {};
  for (const name of ['bash', 'rustup']) {
    const found = spawnSync('which', [name], { encoding: 'utf8', timeout: 10000 });
    if (found.status !== 0 || found.error) {
      if (process.env.NATIVE_COMPILER_CONTROL_REQUIRED === '1') assert.fail(`required real ${name} missing`);
      t.skip(`real ${name} unavailable; install the native toolchain`); return;
    }
    tools[name] = realpathSync(found.stdout.trim());
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'native-cargo-resolution-')));
  try {
    const before = join(directory, 'parent-bin'), after = join(directory, 'sourced-bin');
    for (const path of [before, after]) {
      mkdirSync(path); copyFileSync(tools.rustup, join(path, 'rustup'));
      symlinkSync('rustup', join(path, 'cargo'));
    }
    const cargoEnvPath = join(directory, 'cargo-env');
    writeFileSync(cargoEnvPath, `export PATH=${quote(after)}:"$PATH"\n`);
    const environment = { ...process.env, PATH: `${before}:${process.env.PATH}` };
    const receipt = await resolveCanonicalCargoShim({ bash: tools.bash, directory, cargoEnvPath, environment });
    await run({ directory, before, after, cargoEnvPath, receipt, tools });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('#6537 canonical CargoEnv selects its real shim after sourcing, independently of the parent PATH', async t => {
  await fixture(t, async ({ directory, before, after, receipt, tools }) => {
    assert.equal(receipt.before.cargo.commandPath, join(before, 'cargo'));
    assert.equal(receipt.before.cargo.realPath, join(before, 'rustup'));
    assert.equal(receipt.after.cargo.commandPath, join(after, 'cargo'));
    assert.equal(receipt.after.cargo.realPath, join(after, 'rustup'));
    assert.equal(receipt.after.rustup.realPath, join(after, 'rustup'));
    assert.equal(receipt.after.cwd, directory);
    assert.equal(receipt.before.cargo.sha256, receipt.after.cargo.sha256, 'actual Rustup copies retain identical bytes');
    assert.equal(sameNativeFile(receipt.before.cargo.fileIdentity, receipt.after.cargo.fileIdentity), false,
      'the sourced executable is a distinct inode, so admitting the parent executable would be wrong');
    const realTool = spawnSync(receipt.after.cargo.realPath, ['--help'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(realTool.status, 0, realTool.stderr);
    assert.match(realTool.stdout, /Rust toolchain installer/);
    await verifyCanonicalCargoResolution(receipt);
    if (process.env.NATIVE_CARGO_RESOLUTION_TEST_OUTPUT) {
      writeFileSync(process.env.NATIVE_CARGO_RESOLUTION_TEST_OUTPUT, JSON.stringify({ receipt,
        tool: tools.rustup, selectedToolHelpExit: realTool.status,
        scope: 'Real CargoEnv PATH selection; no Cargo build, model, startup sampler or performance claim' }, null, 2), { flag: 'wx' });
    }
  });
});
test('#6537 CargoEnv content changes and same-byte proxy replacement invalidate the frozen resolution', async t => {
  await fixture(t, async ({ after, cargoEnvPath, receipt, tools }) => {
    writeFileSync(cargoEnvPath, `export PATH=${quote(after)}:"$PATH"\n# changed\n`);
    await assert.rejects(verifyCanonicalCargoResolution(receipt), /environment source changed/);
    writeFileSync(cargoEnvPath, `export PATH=${quote(after)}:"$PATH"\n`);
    await verifyCanonicalCargoResolution(receipt);
    const replacement = join(after, 'replacement'); copyFileSync(tools.rustup, replacement);
    renameSync(replacement, join(after, 'rustup'));
    await assert.rejects(verifyCanonicalCargoResolution(receipt), /file identity changed/);
  });
});
test('#6537 retargeting a Cargo command symlink cannot reuse a frozen executable receipt', async t => {
  await fixture(t, async ({ before, after, receipt }) => {
    unlinkSync(join(after, 'cargo')); symlinkSync(join(before, 'rustup'), join(after, 'cargo'));
    await assert.rejects(verifyCanonicalCargoResolution(receipt), /symlink target changed/);
  });
});
