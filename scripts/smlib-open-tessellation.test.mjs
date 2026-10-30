// SPDX-License-Identifier: MPL-2.0
// #7955: an open (non-manifold) Boolean result must reach the caller as a typed
// kernel refusal (status 4), never as a tessellation success carrying spine or
// lamina edges. The worker is rebuilt from THIS checkout's adapter source before
// it is driven, so a revert of native/smlib-adapter/src/mesh.cpp is observed by
// the same run. Needs a configured native CMake build of the pinned SDK; without
// one it skips (it is not evidence then).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = process.env.IFCLITE_SMLIB_NATIVE_BUILD;
const adapter = fileURLToPath(new URL('../native/smlib-adapter', import.meta.url));
if (!build && process.env.IFCLITE_REQUIRE_SMLIB) throw new Error('IFCLITE_SMLIB_NATIVE_BUILD is required');

function rebuildWorker() {
  const cache = readFileSync(join(build, 'CMakeCache.txt'), 'utf8');
  const home = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(cache)?.[1];
  assert.equal(home && realpathSync(home), realpathSync(adapter), 'native build must be configured from this checkout');
  const result = spawnSync(process.env.CMAKE ?? 'cmake', ['--build', build, '--target', 'ifclite_smlib_worker'],
    { encoding: 'utf8', timeout: 600000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const worker = join(build, 'ifclite_smlib_worker');
  assert.ok(existsSync(worker), 'rebuilt worker executable');
  return worker;
}

/** One worker process speaking the length-prefixed native protocol (README "Native subprocess protocol"). */
function connect(executable) {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buffered = Buffer.alloc(0), waiting = null, exited = false, id = 0;
  const wake = () => { const resolve = waiting; waiting = null; resolve?.(); };
  child.stdout.on('data', (chunk) => { buffered = Buffer.concat([buffered, chunk]); wake(); });
  child.on('exit', () => { exited = true; wake(); });
  const read = async (count) => {
    while (buffered.length < count) {
      if (exited) throw new Error('worker exited before a complete response');
      await new Promise((resolve) => { waiting = resolve; });
    }
    const out = buffered.subarray(0, count); buffered = buffered.subarray(count); return out;
  };
  const call = async (op, ...parts) => {
    const payload = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    const head = Buffer.alloc(16);
    head.writeUInt32LE(12 + payload.length, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(++id, 8); head.writeUInt32LE(op, 12);
    child.stdin.write(Buffer.concat([head, payload]));
    const size = (await read(4)).readUInt32LE(0);
    const body = await read(size);
    assert.equal(body.readUInt32LE(4), id, 'response id');
    return { status: body.readInt32LE(8), body: body.subarray(12) };
  };
  return { call, close: () => { child.stdin.end(); child.kill(); } };
}

const f64 = (...values) => new Float64Array(values), u32 = (...values) => new Uint32Array(values);

test('open Boolean tessellation is a typed kernel refusal on a rebuilt worker (#7955)', {
  timeout: 900000,
  skip: !build && 'SKIP: set IFCLITE_SMLIB_NATIVE_BUILD to a configured native SMLib build; not evidence',
}, async () => {
  const worker = connect(rebuildWorker());
  try {
    const session = (await worker.call(1)).body;
    const box = async (...dims) => {
      const reply = await worker.call(3, session, f64(...dims));
      assert.equal(reply.status, 0, 'box');
      return reply.body;
    };
    // Unit cubes sharing only the edge x=y=1: a valid point set, not a 2-manifold solid.
    const a = await box(0, 0, 0, 1, 1, 1), b = await box(1, 1, 0, 1, 1, 1);
    const union = await worker.call(5, session, a, b, u32(1));
    assert.equal(union.status, 0, 'union');
    const manifold = await worker.call(7, session, union.body);
    assert.equal(manifold.body.readUInt32LE(0), 0, 'SMLib reports the union non-manifold (inputManifold=false)');
    const open = await worker.call(9, session, union.body, f64(0.001, 5));
    assert.equal(open.status, 4, 'open tessellation must be IFCLITE_SMLIB_KERNEL_ERROR, not a success');
    assert.match(open.body.toString('utf8'), /boundary or spine edges/);
    // The refusal leaves the session usable: a closed operand still tessellates closed.
    const closed = await worker.call(9, session, a, f64(0.001, 5));
    assert.equal(closed.status, 0, 'closed operand tessellates');
    const info = await worker.call(10, session, closed.body);
    assert.deepEqual([info.body.readUInt32LE(12), info.body.readUInt32LE(16)], [0, 0], 'no lamina/spine edges');
  } finally { worker.close(); }
  console.log('sdk witness executed: open_tessellation_rebuilt_worker');
});
