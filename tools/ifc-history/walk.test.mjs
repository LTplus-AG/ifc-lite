/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
// Keep temporary Git repositories independent of the invoking checkout/user.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];
// A reverted new tool must fail on an assertion, rather than module loading.
const walker = await import('./walk.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

const script = fileURLToPath(new URL('./walk.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
const fixture = readFileSync(new URL('../../tests/fixtures/cli-retained/layered-wall.ifc', import.meta.url), 'utf8');

function history(t, release = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ifc-history-test-'));
  t.after(async () => {
    await release();
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim();
  git('init', '--quiet');
  const path = 'model with spaces.ifc';
  const commit = (bytes, name) => {
    writeFileSync(join(repo, path), bytes);
    git('add', '--', path);
    git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const base = commit(fixture, 'base');
  const same = commit(fixture.replace('synthetic.ifc', 'delivery.ifc'), 'header only');
  const modified = commit(fixture.replace('stable-box', 'edited-box'), 'attribute edit');
  let id = 0;
  const regenerated = fixture.replace('stable-box', 'edited-box')
    .replace(/(=IFC[A-Z0-9_]+\()'[^']*'/g, (prefix) => {
      // Every IfcRoot's first argument is a GlobalId; non-root first strings
      // in this fixture are not matched (their first argument is not a string).
      return prefix.slice(0, prefix.indexOf("'")) + `'${String(++id).padStart(22, '0')}'`;
    });
  const renamed = commit(regenerated, 'all GlobalIds regenerated');
  return { repo, git, path, base, same, modified, renamed, commit, regenerated };
}

test('#9332 real CLI: consecutive revisions distinguish unchanged, modified and re-GUIDed', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  const lines = [];
  await walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out: line => lines.push(line) });
  assert.equal(lines.length, 3);
  const counts = [
    '5 unchanged, 0 modified, 0 added, 0 deleted, 0 content-matches',
    '4 unchanged, 1 modified, 0 added, 0 deleted, 0 content-matches',
    '0 unchanged, 0 modified, 0 added, 0 deleted, 5 content-matches (5 renamed)',
  ];
  for (const [i, [base, head]] of [[h.base, h.same], [h.same, h.modified], [h.modified, h.renamed]].entries()) {
    assert.equal(lines[i], `${head.slice(0, 12)}: ${counts[i]}; ${base.slice(0, 12)} -> ${head.slice(0, 12)} ${JSON.stringify(h.path)}`);
  }
  // The walk must ignore dirty working files and support a pinned tip.
  writeFileSync(join(h.repo, h.path), 'not IFC');
  const pinned = [];
  await walker.walkHistory({ repository: h.repo, ref: h.same, command: [process.execPath, cli], out: line => pinned.push(line) });
  assert.deepEqual(pinned, lines.slice(0, 1));
  assert.ok(h.git('status', '--porcelain').includes(h.path));
});

test('#9332 failed pair exits nonzero and identifies the commit and path', async (t) => {
  const h = history(t);
  const result = spawnSync(process.execPath, [script, h.repo, '--ifc-lite', join(h.repo, 'missing-binary')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(h.base));
  assert.ok(result.stderr.includes(h.same));
  assert.ok(result.stderr.includes(h.path));
});

test('#9332 real CLI counts added/deleted entities and aggregates files per commit', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  h.commit(fixture, 'restore original identities before independent add/delete checks');
  const extra = "#90=IFCWALL('0000000000000000000090',$,'extra-wall',$,$,#24,#26,$,.NOTDEFINED.);\n";
  const withExtra = fixture.replace('ENDSEC;\nEND-ISO', extra + 'ENDSEC;\nEND-ISO');
  const added = h.commit(withExtra, 'extra wall and original identities');
  const deleted = h.commit(fixture, 'remove extra wall');
  // Seed a second chain, then edit both files in one commit.
  writeFileSync(join(h.repo, 'second.ifc'), fixture);
  h.git('add', 'second.ifc');
  h.commit(fixture.replace('synthetic.ifc', 'seed.ifc'), 'second model');
  writeFileSync(join(h.repo, 'second.ifc'), fixture.replace('stable-box', 'second-edit'));
  h.git('add', 'second.ifc');
  const both = h.commit(fixture.replace('stable-box', 'first-edit'), 'two models edited');
  const lines = [];
  await walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out: line => lines.push(line) });
  assert.ok(lines.find(line => line.startsWith(added.slice(0, 12))).includes('1 added, 0 deleted'));
  assert.ok(lines.find(line => line.startsWith(deleted.slice(0, 12))).includes('0 added, 1 deleted'));
  const aggregate = lines.filter(line => line.startsWith(both.slice(0, 12)));
  assert.equal(aggregate.length, 1);
  assert.ok(aggregate[0].includes('8 unchanged, 2 modified, 0 added, 0 deleted'));
  assert.ok(aggregate[0].includes('"second.ifc"'));
  // Deletion and re-creation start a new chain, never compare across absence.
  h.git('rm', '--', h.path);
  h.git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'delete model');
  h.commit(fixture, 'new model at old path');
  const after = [];
  await walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out: line => after.push(line) });
  assert.deepEqual(after, lines);
});

test('#9332 first-parent merge, blob reuse, non-IFC commits, subdirectories and symlinks', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  h.git('branch', 'side', h.base);
  h.git('checkout', '--quiet', 'side');
  h.commit(fixture.replace('stable-box', 'side-edit'), 'side revision');
  h.git('checkout', '--quiet', '-');
  writeFileSync(join(h.repo, 'notes.txt'), 'not a model');
  symlinkSync(h.path, join(h.repo, 'link.ifc'));
  h.git('add', 'notes.txt', 'link.ifc');
  h.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'no IFC blob changes');
  // A gitlink named .ifc is a directory, not a model blob.
  for (const target of [h.base, h.same]) {
    if (target === h.same) {
      rmSync(join(h.repo, 'link.ifc'));
      symlinkSync('notes.txt', join(h.repo, 'link.ifc'));
      writeFileSync(join(h.repo, 'notes.txt'), 'changed non-model content');
      h.git('add', 'link.ifc', 'notes.txt');
    }
    h.git('update-index', '--add', '--cacheinfo', `160000,${target},module.ifc`);
    h.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'submodule revision');
  }
  h.git('-c', 'commit.gpgsign=false', 'merge', '--quiet', '--no-ff', '-s', 'ours', 'side', '-m', 'retain first-parent delivery');
  const next = h.commit(h.regenerated.replace('edited-box', 'after-merge'), 'next delivery');
  const lines = [];
  mkdirSync(join(h.repo, 'nested'));
  await walker.walkHistory({ repository: join(h.repo, 'nested'), command: [process.execPath, cli], out: line => lines.push(line) });
  assert.equal(lines.length, 4, 'side branch, symlink and non-IFC commits must print nothing');
  assert.ok(lines[3].includes(`${h.renamed.slice(0, 12)} -> ${next.slice(0, 12)}`), 'reuse the commit introducing the blob, not the intervening merge');
  assert.ok(lines[3].includes('4 unchanged, 1 modified'));
});

test('#9332 unresolved LFS pointers fail explicitly without requiring Git LFS', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  const bad = h.commit('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n', 'pointer only');
  await assert.rejects(walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out() {} }), error => {
    assert.ok(error.message.includes('Unresolved Git LFS pointer'));
    assert.ok(error.message.includes(h.renamed));
    assert.ok(error.message.includes(bad));
    return true;
  });
});

test('#9332 invalid IFC revision fails through the real CLI and names both revisions', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  const bad = h.commit('This delivery is not IFC.', 'invalid delivery');
  await assert.rejects(walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out() {} }), error => {
    assert.ok(error.message.includes(h.renamed));
    assert.ok(error.message.includes(bad));
    assert.ok(error.message.includes(h.path));
    assert.match(error.message, /IFC|STEP/);
    return true;
  });
});

test('#9332 smudge filters supply revision bytes instead of raw stored blobs', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  h.commit(fixture, 'restore canonical delivery');
  const filter = join(h.repo, 'smudge.mjs');
  writeFileSync(filter, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" + JSON.stringify(fixture) + "));\n");
  h.git('config', 'filter.model.smudge', `"${process.execPath}" "${filter}"`);
  writeFileSync(join(h.repo, '.gitattributes'), '*.ifc filter=model\n');
  h.git('add', '.gitattributes');
  const filtered = h.commit('Stored transport representation', 'filtered delivery');
  const lines = [];
  await walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out: line => lines.push(line) });
  assert.equal(lines.length, 5);
  assert.ok(lines[4].startsWith(filtered.slice(0, 12)));
  assert.ok(lines[4].includes('5 unchanged, 0 modified, 0 added, 0 deleted'));
});

test('#9332 blobs larger than 256 MiB reach the consumer without buffering or truncation', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  const block = Buffer.alloc(1024 * 1024, 120);
  const file = join(h.repo, h.path);
  for (let i = 0; i < 257; i++) appendFileSync(file, block);
  h.git('add', '--', h.path);
  h.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'large transport blob');
  const checker = join(h.repo, 'check-bytes.mjs');
  const size = Buffer.byteLength(h.regenerated) + 257 * block.length;
  const counter = join(h.repo, 'checked-revisions.txt');
  const expected = [
    fixture.replace('synthetic.ifc', 'delivery.ifc'),
    fixture.replace('stable-box', 'edited-box'),
    h.regenerated,
  ].map(bytes => ({ size: Buffer.byteLength(bytes), tail: [...Buffer.from(bytes).subarray(-16)] }));
  expected.push({ size, tail: Array(16).fill(120) });
  // Each invocation has an independent expected length and tail, including
  // the large revision. Truncating below the old threshold cannot skip checks.
  writeFileSync(checker, `import {statSync,openSync,readSync,closeSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const counter=${JSON.stringify(counter)}, expected=${JSON.stringify(expected)};
const index=existsSync(counter)?Number(readFileSync(counter,'utf8')):0;
assert.ok(index<expected.length);
const path=process.argv[4], size=statSync(path).size;
assert.equal(size,expected[index].size);
const fd=openSync(path,'r'), tail=Buffer.alloc(16);
try { assert.equal(readSync(fd,tail,0,16,size-16),16); } finally { closeSync(fd); }
assert.deepEqual([...tail],expected[index].tail);
writeFileSync(counter,String(index+1));
console.log(JSON.stringify({counts:{unchanged:5,modified:0,added:0,deleted:0},contentMatches:[]}));`);
  const lines = [];
  await walker.walkHistory({ repository: h.repo, command: [process.execPath, checker], out: line => lines.push(line) });
  assert.equal(lines.length, 4);
  assert.equal(readFileSync(counter, 'utf8'), '4');
});

test('#9332 SIGINT removes scratch files while a diff is active', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  let child;
  const h = history(t, async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  const marker = join(h.repo, 'ready.json');
  const consumer = join(h.repo, 'wait.mjs');
  writeFileSync(consumer, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({path:process.argv[3]}));
setInterval(()=>{},1000);`);
  child = spawn(process.execPath, ['--input-type=module', '-e',
    `const {walkHistory}=await import(${JSON.stringify(pathToFileURL(script).href)}); await walkHistory({repository:${JSON.stringify(h.repo)},command:${JSON.stringify([process.execPath, consumer])}});`], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(marker), 'diff must have started before sending SIGINT');
  const { path } = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ok(existsSync(path));
  child.kill('SIGINT');
  const [code] = await exited;
  assert.equal(code, 130);
  assert.equal(existsSync(path), false);
});

test('#9332 CLI calls have a bounded timeout', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  const consumer = join(h.repo, 'timeout.mjs');
  writeFileSync(consumer, 'setInterval(()=>{},1000);');
  await assert.rejects(walker.walkHistory({ repository: h.repo, command: [process.execPath, consumer], timeout: 100 }), error => {
    assert.ok(error.message.includes(h.base));
    assert.ok(error.message.includes(h.same));
    assert.equal(error.cause.killed, true);
    return true;
  });
});

test('#9332 historical LFS attributes survive a later rule removal', async (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  h.commit(fixture, 'restore canonical delivery');
  const filter = join(h.repo, 'lfs-smudge.mjs');
  writeFileSync(filter, `let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input+=chunk);
process.stdin.on('end', () => process.stdout.write(input.startsWith('version https://git-lfs.github.com/spec/v1') ? ${JSON.stringify(fixture)} : input));`);
  h.git('config', 'filter.lfs.smudge', `"${process.execPath}" "${filter}"`);
  h.git('config', 'filter.lfs.required', 'true');
  writeFileSync(join(h.repo, '.gitattributes'), '*.ifc filter=lfs\n');
  h.git('add', '.gitattributes');
  const pointer = oid => 'version https://git-lfs.github.com/spec/v1\noid sha256:' + oid.repeat(64) + '\nsize ' + Buffer.byteLength(fixture) + '\n';
  h.commit(pointer('a'), 'first pointer delivery');
  h.commit(pointer('b'), 'second pointer delivery');
  h.git('rm', '.gitattributes');
  const removed = h.commit(fixture, 'remove rule and store plain IFC');
  const lines = [];
  await walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out: line => lines.push(line) });
  assert.equal(lines.length, 7);
  for (const line of lines.slice(-3)) assert.ok(line.includes('5 unchanged, 0 modified, 0 added, 0 deleted'));
  assert.ok(lines.at(-1).startsWith(removed.slice(0, 12)));
});
