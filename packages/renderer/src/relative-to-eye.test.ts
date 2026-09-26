/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5049 — RTE is an arithmetic contract, not just a pair of extra uniforms.
 * These cases use a multi-million-metre source frame where direct f32 world
 * upload loses millimetre-scale geometry, and pin the CPU/WGSL packing order
 * that every renderer path will share while it is migrated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MathUtils } from './math.js';
import { Camera } from './camera.js';
import {
  RelativeToEyeFrame,
  RTE_FRAME_FLOATS,
  RTE_ORIGIN_FLOATS,
  RTE_UNIFORM_LAYOUT,
  MAX_RTE_EYE_RELATIVE_METRES,
  MAX_RTE_SOURCE_ABS_METRES,
  assertRteUniformAbi,
  packRteOrigin,
  reflectRteUniformStruct,
  rteRelativePositionF32,
  splitFloat64ForRte,
  translationFreeViewProjection,
  tryPackRteDrawableDelta,
  unpackRteOrigin,
} from './relative-to-eye.js';
import { relativeToEyeWgsl } from './shaders/relative-to-eye.wgsl.js';

function close(actual: number, expected: number, tolerance = 1e-7): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} ± ${tolerance}`);
}

function packDrawableDelta(drawable: readonly [number, number, number], camera: readonly [number, number, number]): Float32Array {
  const packed = new Float32Array(RTE_ORIGIN_FLOATS);
  packRteOrigin([
    drawable[0] - camera[0], drawable[1] - camera[1], drawable[2] - camera[2],
  ], packed);
  return packed;
}

describe('relative-to-eye packing (#5049)', () => {
  it('uses one Camera-owned frame instead of creating per-consumer rebases', () => {
    const camera = new Camera();
    camera.setPosition(5_000_000, 0, 10);
    camera.setTarget(5_000_000, 0, 0);
    const first = camera.getRelativeToEyeFrame();
    const second = camera.getRelativeToEyeFrame();
    assert.strictEqual(first, second);
    assert.deepStrictEqual(first.getCameraWorld(), [5_000_000, 0, 10]);
    const epoch = first.getRenderEpoch();
    assert.equal(second.getRenderEpoch(), epoch, 'reads are snapshot-stable');
    camera.setPosition(5_000_001, 0, 10);
    assert.equal(first.getRenderEpoch(), epoch + 1, 'an accepted camera update advances the snapshot');
  });

  it('captures immutable camera-relative inputs for asynchronous GPU readback', () => {
    const frame = new RelativeToEyeFrame();
    frame.update(
      { x: 5_000_000.25, y: 0, z: 0 },
      MathUtils.identity(),
      MathUtils.identity(),
    );
    const snapshot = frame.snapshot();
    const packed = new Float32Array(RTE_ORIGIN_FLOATS);
    snapshot.packDrawableOrigin([5_000_000.5, 0, 0], packed);
    frame.update(
      { x: 5_000_100.25, y: 0, z: 0 },
      MathUtils.identity(),
      MathUtils.identity(),
    );
    assert.equal(snapshot.renderEpoch, 1);
    assert.deepStrictEqual(snapshot.getCameraWorld(), [5_000_000.25, 0, 0]);
    assert.equal(rteRelativePositionF32([0, 0, 0], packed)[0], 0.25);
  });
  it('retains a centimetre-sized local vertex at a multi-million-metre offset', () => {
    const drawable = packDrawableDelta([5_000_000, -3_000_000, 2_000_000], [5_000_000, -3_000_000, 2_000_000]);

    const local: [number, number, number] = [0.025, -0.0125, 0.03125];
    const relative = rteRelativePositionF32(local, drawable);

    // This is the exact failure RTE prevents: the f32 upload of the absolute
    // coordinate has no room left for 2.5 cm at a five-million-metre offset.
    assert.equal(Math.fround(5_000_000 + local[0]) - Math.fround(5_000_000), 0);
    close(relative[0], local[0]);
    close(relative[1], local[1]);
    close(relative[2], local[2]);
  });

  it('cancels neighbouring high lanes before adding the low residual', () => {
    const cameraWorld: [number, number, number] = [5_000_000.25, 4_000_000.125, -6_000_000.5];
    const drawableWorld: [number, number, number] = [5_000_000.75, 3_999_999.875, -5_999_999.75];
    const drawable = packDrawableDelta(drawableWorld, cameraWorld);

    const got = rteRelativePositionF32([0.125, -0.25, 0.0625], drawable);
    close(got[0], 0.625);
    close(got[1], -0.5);
    close(got[2], 0.8125);
  });

  it('uses cancellation-first arithmetic across local template extents', () => {
    // High lanes differ by 1 m while the low lanes contain a 25 cm residual.
    const drawable = packDrawableDelta([4_194_305.5, 0, 0], [4_194_304.25, 0, 0]); // 2^22 boundary
    for (const local of [-1_000_000, -10_000, -1_000, 1_000, 10_000, 1_000_000]) {
      const expected = Math.fround(Math.fround(Math.fround(local) + 1) + 0.25);
      assert.equal(rteRelativePositionF32([local, 0, 0], drawable)[0], expected, `local ${local}`);
    }
  });

  it('retains the low origin after a million-metre local/high cancellation', () => {
    const witness = (cameraX: number): number => {
      const drawable = packDrawableDelta([cameraX + 1_000_000.025, 0, 0], [cameraX, 0, 0]);
      return rteRelativePositionF32([-1_000_000, 0, 0], drawable)[0];
    };
    // The old `local + (highDelta + lowDelta)` association returns zero: the
    // 2.5 cm low lane disappears when joined to a 1,000,000 m high delta.
    assert.equal(witness(10_000_000), 0.02500000037252903);
    assert.equal(witness(8_388_608), 0.02500000037252903, 'same witness across an f32 exponent boundary');
  });

  it('forms the drawable-camera delta in f64 before splitting in-envelope origins', () => {
    const delta = packDrawableDelta([1_000_000, 0, 0], [0.025, 0, 0]);
    assert.equal(rteRelativePositionF32([-1_000_000, 0, 0], delta)[0], -0.02500000037252903);
  });

  it('survives f32 high-lane exponent boundaries and common source translations', () => {
    const local: [number, number, number] = [12.5, -0.125, 0.03125];
    const relativeFor = (translation: number): [number, number, number] => {
      const drawable = packDrawableDelta(
        [translation + 4_194_304.25, translation - 4_194_304.75, translation + 8_388_609.25],
        [translation + 4_194_303.75, translation - 4_194_304.25, translation + 8_388_608.5],
      );
      return rteRelativePositionF32(local, drawable);
    };
    const nearby = relativeFor(0);
    const remote = relativeFor(10_000_000);
    assert.deepStrictEqual(nearby, [13, -0.625, 0.78125]);
    assert.deepStrictEqual(remote, nearby, 'a common national-grid translation changes no eye-relative result');
  });

  it('writes stable vec4-aligned high/low lanes and reconstructs source coordinates', () => {
    const origin: [number, number, number] = [5_000_000.125, -3_000_000.0625, 42.5];
    const packed = new Float32Array(RTE_ORIGIN_FLOATS);
    packRteOrigin(origin, packed);

    assert.equal(packed[3], 0, 'high vec4 padding is cleared');
    assert.equal(packed[7], 0, 'low vec4 padding is cleared');
    const unpacked = unpackRteOrigin(packed);
    for (let axis = 0; axis < 3; axis++) close(unpacked[axis], origin[axis]);
  });

  it('enforces source and eye-relative envelopes at the packing boundary', () => {
    assert.throws(() => splitFloat64ForRte(MAX_RTE_SOURCE_ABS_METRES + 1), /source envelope/);
    const frame = new RelativeToEyeFrame();
    const eye = { x: 0, y: 0, z: 0 };
    frame.update(eye, MathUtils.identity(), MathUtils.identity());
    assert.throws(
      () => frame.packDrawableOrigin([MAX_RTE_EYE_RELATIVE_METRES + 1, 0, 0], new Float32Array(RTE_ORIGIN_FLOATS)),
      /camera-relative envelope/,
    );
    frame.update({ x: MAX_RTE_SOURCE_ABS_METRES, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity());
    assert.throws(
      () => frame.packDrawableOrigin([MAX_RTE_SOURCE_ABS_METRES + 1, 0, 0], new Float32Array(RTE_ORIGIN_FLOATS)),
      /source envelope/,
      'validate the original drawable source origin before its small delta is formed',
    );
    assert.throws(
      () => frame.update({ x: MAX_RTE_SOURCE_ABS_METRES + 1, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity()),
      /source envelope/,
      'camera source coordinates are checked even though they are no longer uploaded',
    );
  });

  it('tryPack skips an out-of-envelope drawable without writing, and still rejects bad source data (#6128)', () => {
    const out = new Float32Array(RTE_ORIGIN_FLOATS).fill(7);
    for (const axis of [0, 1, 2]) {
      const origin: [number, number, number] = [0, 0, 0];
      origin[axis] = -(MAX_RTE_EYE_RELATIVE_METRES + 1);
      assert.strictEqual(tryPackRteDrawableDelta(origin, [0, 0, 0], out, 0), false);
    }
    assert.deepStrictEqual(Array.from(out), new Array(RTE_ORIGIN_FLOATS).fill(7), 'a skipped drawable leaves the lanes untouched');

    assert.strictEqual(tryPackRteDrawableDelta([MAX_RTE_EYE_RELATIVE_METRES, 0, 0], [0, 0, 0], out, 0), true, 'the envelope is inclusive');
    assert.deepStrictEqual(unpackRteOrigin(out), [MAX_RTE_EYE_RELATIVE_METRES, 0, 0]);

    assert.throws(() => tryPackRteDrawableDelta([MAX_RTE_SOURCE_ABS_METRES + 1, 0, 0], [0, 0, 0], out, 0), /source envelope/);
    assert.throws(() => tryPackRteDrawableDelta([0, 0, 0], [0, 0, Number.NaN], out, 0), /finite/);

    const frame = new RelativeToEyeFrame();
    frame.update({ x: 0, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity());
    assert.strictEqual(frame.tryPackDrawableOrigin([0, MAX_RTE_EYE_RELATIVE_METRES + 1, 0], out), false);
    assert.strictEqual(frame.snapshot().tryPackDrawableOrigin([0, 0, 1], out), true);
    assert.throws(
      () => frame.packDrawableOrigin([0, 0, MAX_RTE_EYE_RELATIVE_METRES + 1], out),
      /camera-relative envelope on axis 2/,
      'the strict packer still names the offending axis',
    );
  });

  it('keeps CPU ray/snap/measure coordinates in f64 while GPU uniforms are split', () => {
    const frame = new RelativeToEyeFrame();
    const eye = { x: 5_000_000.25, y: -3_000_000.5, z: 2_000_000.125 };
    frame.update(eye, MathUtils.identity(), MathUtils.lookAt(eye, { x: eye.x, y: eye.y, z: eye.z - 1 }, { x: 0, y: 1, z: 0 }));

    assert.deepStrictEqual(frame.worldToRelative([5_000_000.275, -3_000_000.5125, 2_000_000.15625]), [0.02500000037252903, -0.012500000186264515, 0.03125]);
    const packed = new Float32Array(RTE_FRAME_FLOATS);
    frame.packUniforms(packed);
    assert.deepStrictEqual(Array.from(packed), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('removes eye translation from view-projection but leaves projection depth semantics intact', () => {
    const projection = MathUtils.perspectiveReverseZ(Math.PI / 3, 1.5, 0.1, 10_000);
    const view = MathUtils.lookAt(
      { x: 5_000_000.25, y: -3_000_000.5, z: 2_000_000.125 },
      { x: 5_000_000.25, y: -3_000_000.5, z: 1_999_999.125 },
      { x: 0, y: 1, z: 0 },
    );
    const translated = MathUtils.multiply(projection, view);
    const relative = translationFreeViewProjection(projection, view);

    // The normal perspective matrix owns a depth offset (m14), so it survives;
    // the large eye-derived X/Y translation does not.
    assert.notEqual(translated.m[12], relative.m[12]);
    assert.notEqual(translated.m[13], relative.m[13]);
    close(relative.m[14], projection.m[14]);
  });

  it('reflects exact WGSL offsets and rejects padding, field swaps and arithmetic drift', () => {
    assertRteUniformAbi();
    assert.deepStrictEqual(reflectRteUniformStruct(relativeToEyeWgsl, 'RteFrameUniform'), RTE_UNIFORM_LAYOUT.frame);
    assert.throws(() => assertRteUniformAbi(relativeToEyeWgsl.replace(
      'drawableDeltaHigh: vec4<f32>,', 'padding: vec4<f32>,\n  drawableDeltaHigh: vec4<f32>,',
    )), /does not match/);
    assert.throws(() => assertRteUniformAbi(relativeToEyeWgsl.replace(
      'drawableDeltaHigh: vec4<f32>,\n  drawableDeltaLow', 'drawableDeltaLow: vec4<f32>,\n  drawableDeltaHigh',
    )), /does not match/);
    const mutatedArithmetic = relativeToEyeWgsl.replace('(local + highDelta) + lowDelta', 'local + (highDelta + lowDelta)');
    assert.throws(() => assertRteUniformAbi(mutatedArithmetic), /must evaluate/);
  });

  it('executes packed origins through WGSL and reads the relative position back on WebGPU', {
    skip: globalThis.navigator?.gpu === undefined ? 'requires a real WebGPU adapter; Node test environment has none' : false,
  }, async () => {
    const adapter = await globalThis.navigator.gpu!.requestAdapter();
    if (!adapter) throw new Error('WebGPU is present but no adapter is available for the RTE readback witness.');
    const device = await adapter.requestDevice();
    const frame = new RelativeToEyeFrame();
    const eye = { x: 10_000_000, y: -4_194_304.25, z: 8_388_608.5 };
    frame.update(eye, MathUtils.identity(), MathUtils.lookAt(eye, { ...eye, z: eye.z - 1 }, { x: 0, y: 1, z: 0 }));
    const drawableData = new Float32Array(RTE_ORIGIN_FLOATS);
    // This stays within the ±1,000,000 m accepted delta envelope. The prior
    // positive witness (11,000,000.025) is intentionally outside it.
    frame.packDrawableOrigin([10_999_999.975, -4_194_304.75, 8_388_609.25], drawableData);
    const drawableBuffer = device.createBuffer({ size: drawableData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const resultBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      device.queue.writeBuffer(drawableBuffer, 0, drawableData);
      const module = device.createShaderModule({ code: `${relativeToEyeWgsl}
        @group(0) @binding(0) var<uniform> drawable: RteDrawableUniform;
        @group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
        @compute @workgroup_size(1) fn main() { result[0] = rteWorldPosition(vec3<f32>(-1000000.0, -0.25, 0.0625), drawable); }
      ` });
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: drawableBuffer } },
        { binding: 1, resource: { buffer: resultBuffer } },
      ] });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1); pass.end();
      encoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const got = new Float32Array(readback.getMappedRange().slice(0));
      const expected = rteRelativePositionF32([-1_000_000, -0.25, 0.0625], drawableData);
      assert.deepStrictEqual(Array.from(got), [...expected, 1]);
      assert.equal(got[0], -0.02500000037252903, 'the GPU witness must reject the old association');
      readback.unmap();

      // Repeat the exact association witness over the 2^23 high-lane boundary.
      const boundaryEye = { x: 8_388_608, y: eye.y, z: eye.z };
      frame.update(boundaryEye, MathUtils.identity(), MathUtils.lookAt(boundaryEye, { ...boundaryEye, z: boundaryEye.z - 1 }, { x: 0, y: 1, z: 0 }));
      frame.packDrawableOrigin([9_388_607.975, -4_194_304.75, 8_388_609.25], drawableData);
      device.queue.writeBuffer(drawableBuffer, 0, drawableData);
      const boundaryEncoder = device.createCommandEncoder();
      const boundaryPass = boundaryEncoder.beginComputePass();
      boundaryPass.setPipeline(pipeline); boundaryPass.setBindGroup(0, bindGroup); boundaryPass.dispatchWorkgroups(1); boundaryPass.end();
      boundaryEncoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, 16);
      device.queue.submit([boundaryEncoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const boundaryGot = new Float32Array(readback.getMappedRange().slice(0));
      assert.equal(boundaryGot[0], -0.02500000037252903, 'the exponent-boundary GPU witness must retain the low delta');
      readback.unmap();
    } finally {
      drawableBuffer.destroy(); resultBuffer.destroy(); readback.destroy();
      device.destroy();
    }
  });
});
