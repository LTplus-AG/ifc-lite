/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flip a material's `transparent` flag so the change actually reaches the
 * shader — the one transparency field on a three.js material that a plain
 * assignment does not deliver.
 *
 * Both `/mcp` scenes re-derive transparency at runtime (`colorize()` /
 * `reset()` in `playground-scene-ops.ts`, and the hero's per-frame opacity
 * lerp), and both used to assign the field directly. In three r185 that leaves
 * the previously compiled program bound:
 *
 * 1. `WebGLPrograms.getParameters()` folds the flag into a PROGRAM parameter —
 *    `opaque: material.transparent === false && material.blending ===
 *    NormalBlending && material.alphaToCoverage === false`
 *    (`build/three.module.js:7635`).
 * 2. `parameters.opaque` becomes a preprocessor define (`:7010`,
 *    `parameters.opaque ? '#define OPAQUE' : ''`) and part of the program
 *    cache key (`:7954`).
 * 3. The `opaque_fragment` chunk (`:461`) is
 *    `#ifdef OPAQUE\ndiffuseColor.a = 1.0;\n#endif`, so an OPAQUE program
 *    forces every fragment to alpha 1 no matter what `opacity` says.
 * 4. `WebGLRenderer.setProgram()`'s `needsProgramChange` chain (`:18382`)
 *    only runs at all while `material.version === materialProperties.__version`
 *    and never inspects `transparent` or `opaque` — grep the whole block for
 *    either and it returns nothing. Only `material.needsUpdate = true` bumps
 *    `version` (`three.core.js:7126`), which is what fails that guard and
 *    forces the rebuild.
 *
 * So an entity that loaded opaque stayed visually opaque through a translucent
 * `viewer_colorize`, and the mirror case stayed blended after being painted
 * opaque (#2454).
 *
 * The two fields either side of it need none of this, which is exactly why the
 * defect was easy to miss and why `needsUpdate` is NOT sprinkled on them:
 * `opacity` is a uniform, re-uploaded every frame, and `depthWrite` is
 * per-draw state (`depthBuffer.setMask(material.depthWrite)`, `:10413`).
 * `colorize()`'s `depthWrite` fix (#2444) is sound exactly as written.
 *
 * The transition guard is load-bearing, not an optimisation: the hero's
 * animation loop re-derives `transparent` on every element on every frame, so
 * an unconditional `needsUpdate` there would bump `version` 60 times a second
 * per material. Three's program cache absorbs the worst of that — an identical
 * parameter set is served as a cache hit rather than recompiled — so the cost
 * is a full `getParameters()` build and cache lookup per material per frame,
 * not a shader recompile. Still worth avoiding, and cheap to avoid.
 */

/**
 * The slice of `THREE.Material` this touches. Structural rather than the class
 * so the mechanism can be exercised against a plain object as well as a real
 * material — `THREE.Material` satisfies it as-is.
 *
 * Note `needsUpdate` is write-only on a real material (three declares a setter
 * with no getter), so reading it back proves nothing; `material.version` is the
 * observable the renderer itself compares.
 */
export interface TransparencyFlaggable {
  transparent: boolean;
  needsUpdate: boolean;
}

/**
 * Set `mat.transparent`, requesting a program rebuild only when the value
 * actually changed. Returns whether it changed.
 */
export function setTransparent(mat: TransparencyFlaggable, transparent: boolean): boolean {
  if (mat.transparent === transparent) return false;
  mat.transparent = transparent;
  // `transparent` is a shader define, not just render state — see the module
  // comment. Without this the old program stays bound.
  mat.needsUpdate = true;
  return true;
}
