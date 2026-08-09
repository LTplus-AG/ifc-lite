/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * That a runtime `transparent` flip reaches the SHADER (#2454).
 *
 * Asserting `material.transparent === true` after the flip would prove
 * nothing: that was already true while the bound program went on forcing
 * `diffuseColor.a = 1.0`. The defect lives one layer down, in which program
 * three.js compiles and binds — so that is what this reads back.
 *
 * The oracle: drive a REAL `THREE.WebGLRenderer` over a stub GL context that
 * records every `shaderSource()` and every `useProgram()`, then read the
 * fragment shader three actually bound for the draw and look for
 * `#define OPAQUE`. Everything that decides the answer is real three.js —
 * `WebGLPrograms.getParameters()`, the define emission, the program cache key,
 * and `setProgram()`'s version-gated `needsProgramChange` guard. Only the GPU
 * is fake, and no GPU is needed to observe a string that three composed on the
 * CPU. That is why this is not the "we can only pin the bookkeeping" test the
 * issue expected.
 *
 * What it still cannot prove: that the GPU, having been handed a program
 * without `#define OPAQUE`, blends the pixels. That is three's and the
 * driver's contract, not ours.
 *
 * The stub is deliberately generous — unknown members resolve to a no-op
 * function, unknown SCREAMING_CASE members to a unique constant — because the
 * point is to get three's own program pipeline to run, not to model WebGL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { setTransparent } from './material-transparency.js';

interface StubGpu {
  renderer: THREE.WebGLRenderer;
  /** Fragment shader source of the program bound by the last draw. */
  boundFragmentShader(): string;
  /** How many programs three has compiled so far. */
  programCount(): number;
}

function createStubGpu(): StubGpu {
  const shaderSources = new Map<object, string>();
  const programShaders = new Map<object, object[]>();
  const constants = new Map<string, number>();
  const constantNames = new Map<number, string>();
  let nextConstant = 0x9000;
  let usedProgram: object | null = null;

  const constant = (name: string): number => {
    let value = constants.get(name);
    if (value === undefined) {
      value = nextConstant++;
      constants.set(name, value);
      constantNames.set(value, name);
    }
    return value;
  };

  const impl: Record<string, unknown> = {
    getContextAttributes: () => ({ alpha: true }),
    getExtension: () => null,
    getParameter: (pname: number) => {
      switch (constantNames.get(pname)) {
        case 'VERSION': return 'WebGL 2.0 (stub)';
        case 'SHADING_LANGUAGE_VERSION': return 'WebGL GLSL ES 3.00 (stub)';
        case 'VENDOR': case 'RENDERER': return 'stub';
        case 'SCISSOR_BOX': case 'VIEWPORT': return new Int32Array([0, 0, 300, 150]);
        default: return 16384;
      }
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createShader: () => ({}),
    shaderSource: (shader: object, source: string) => { shaderSources.set(shader, source); },
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => { const p = {}; programShaders.set(p, []); return p; },
    attachShader: (program: object, shader: object) => { programShaders.get(program)?.push(shader); },
    // LINK_STATUS must be truthy; ACTIVE_UNIFORMS / ACTIVE_ATTRIBUTES 0 keeps
    // three's reflection loops empty, which is all this test needs.
    getProgramParameter: (_p: object, pname: number) => (constantNames.get(pname) === 'LINK_STATUS'),
    getProgramInfoLog: () => '',
    useProgram: (program: object) => { usedProgram = program; },
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createVertexArray: () => ({}),
    createFramebuffer: () => ({}),
    isContextLost: () => false,
  };
  constant('LINK_STATUS');

  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in impl) return impl[prop];
      if (/^[A-Z0-9_]+$/.test(prop)) return constant(prop);
      return () => undefined;
    },
  });

  const canvas = {
    width: 300, height: 150, style: {},
    addEventListener() {}, removeEventListener() {},
  };

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    context: gl as unknown as WebGL2RenderingContext,
  });

  return {
    renderer,
    boundFragmentShader() {
      assert.ok(usedProgram, 'the draw bound no program at all — the harness is broken');
      const sources = (programShaders.get(usedProgram) ?? []).map((s) => shaderSources.get(s) ?? '');
      const fragment = sources.find((s) => s.includes('gl_FragColor'));
      assert.ok(fragment, 'no fragment shader recorded for the bound program');
      return fragment;
    },
    programCount: () => programShaders.size,
  };
}

/** A scene holding one triangle with one material, ready to render. */
function oneTriangleScene(material: THREE.MeshStandardMaterial) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  return { scene, camera };
}

describe('material transparency reaches the shader (#2454)', () => {
  it('binds an OPAQUE program for an opaque material, and drops it on a flip', () => {
    const gpu = createStubGpu();
    const material = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 });
    const { scene, camera } = oneTriangleScene(material);

    gpu.renderer.render(scene, camera);
    assert.match(
      gpu.boundFragmentShader(), /#define OPAQUE/,
      'reachability control: an opaque material must compile WITH the define, '
      + 'or the assertion below would pass without the fix',
    );

    setTransparent(material, true);
    material.opacity = 0.3;
    gpu.renderer.render(scene, camera);

    // The whole point. `#ifdef OPAQUE → diffuseColor.a = 1.0` (three.module.js
    // :461): while that define survives, the entity renders solid however low
    // `opacity` goes, which is exactly what `viewer_colorize` did.
    assert.doesNotMatch(
      gpu.boundFragmentShader(), /#define OPAQUE/,
      'the bound shader still forces alpha 1 — the flip never reached the GPU',
    );
  });

  it('leaves the stale program bound when `transparent` is merely assigned', () => {
    // The defect itself, reproduced against the same oracle. This is what
    // `mat.transparent = translucent` did, and it is why a test asserting
    // `material.transparent === true` proves nothing: it is true here too.
    const gpu = createStubGpu();
    const material = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 });
    const { scene, camera } = oneTriangleScene(material);

    gpu.renderer.render(scene, camera);
    material.transparent = true;
    material.opacity = 0.3;
    gpu.renderer.render(scene, camera);

    assert.equal(material.transparent, true, 'the flag reads back flipped …');
    assert.match(gpu.boundFragmentShader(), /#define OPAQUE/, '… while the shader ignores it');
    assert.equal(gpu.programCount(), 1, 'and three never compiled a second program');
  });

  it('restores an OPAQUE program when a translucent material is painted opaque', () => {
    // The mirror leak: an entity that loaded translucent kept a non-OPAQUE
    // program and stayed blended after `viewer_colorize` painted it solid.
    const gpu = createStubGpu();
    const material = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 });
    const { scene, camera } = oneTriangleScene(material);

    gpu.renderer.render(scene, camera);
    assert.doesNotMatch(gpu.boundFragmentShader(), /#define OPAQUE/, 'control: it loaded translucent');

    setTransparent(material, false);
    material.opacity = 1;
    gpu.renderer.render(scene, camera);

    assert.match(gpu.boundFragmentShader(), /#define OPAQUE/, 'painting it opaque must restore the define');
  });

  it('does not recompile when the flag is re-set to the value it already has', () => {
    // Anti-mutation for the transition guard. The hero re-derives `transparent`
    // for every element on every frame, so an unconditional
    // `mat.needsUpdate = true` would throw away and rebuild every program 60
    // times a second. Dropping the guard makes this fail on the program count.
    const gpu = createStubGpu();
    const material = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 });
    const { scene, camera } = oneTriangleScene(material);

    gpu.renderer.render(scene, camera);
    const compiled = gpu.programCount();
    const versionBefore = material.version;

    for (let frame = 0; frame < 5; frame++) {
      assert.equal(setTransparent(material, false), false, 'a no-op flip reports no change');
      gpu.renderer.render(scene, camera);
    }

    assert.equal(material.version, versionBefore, 'no-op repaints must not bump the material version');
    assert.equal(gpu.programCount(), compiled, 'nor compile a single extra program');
  });

  it('bumps the material version on a real transition, and only then', () => {
    // The bookkeeping, checked without a renderer — `needsUpdate` is
    // write-only on a three material (a setter with no getter), so `version`
    // is the only readable evidence, and it is the exact field
    // `needsProgramChange` compares against `materialProperties.__version`.
    const material = new THREE.MeshStandardMaterial({ transparent: false });
    const start = material.version;

    assert.equal(setTransparent(material, false), false);
    assert.equal(material.version, start);

    assert.equal(setTransparent(material, true), true);
    assert.equal(material.version, start + 1, 'the transition requested a rebuild');
    assert.equal(material.transparent, true);

    assert.equal(setTransparent(material, true), false);
    assert.equal(material.version, start + 1, 'and re-asserting the same value did not');
  });
});
