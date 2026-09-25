/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';

/**
 * The default specular term replaces the fake glass branch (#5386).
 *
 * Before this contract `fs_main` had no specular term at all: the PBR helpers
 * `fresnelSchlick`, `distributionGGX`, `geometrySchlickGGX` and `geometrySmith`
 * were defined and never called, `uniforms.metallicRoughness` was written by
 * the renderer and never read, and glass was faked by a branch that mixed a
 * constant tint, added a flat `glassShine`, desaturated toward grey at grazing
 * angles and force-multiplied alpha by 0.7 — every material with `alpha < 0.99`
 * got the same look regardless of its actual finish, so glass, metal and
 * glossy surfaces all rendered as matte plastic.
 *
 * WGSL cannot run under `tsx --test`, so these assert the shader source at the
 * only level that can see it, in the idiom of `color-pipeline.test.ts` and
 * `sun-softness-wiring.test.ts`: each negative assertion is paired with a
 * positive one so a rename or a deleted feature cannot make it pass
 * vacuously. `mainShaderSource` inlines `specularWgsl` (shaders/specular.wgsl.ts)
 * via a template literal, so the GGX/Smith/Fresnel helpers are visible in it
 * whichever module now defines them — this file loads and fails there against
 * a tree that predates #5386.
 */
describe('default specular term (#5386)', () => {
  it('calls the GGX distribution, Smith geometry and Schlick Fresnel terms from fs_main', () => {
    // Guard the guard: the helpers must still exist as callable functions,
    // not just be named somewhere in a comment.
    assert.match(mainShaderSource, /fn distributionGGX\(/, 'expected fn distributionGGX to be defined');
    assert.match(mainShaderSource, /fn geometrySmith\(/, 'expected fn geometrySmith to be defined');
    assert.match(mainShaderSource, /fn fresnelSchlick\(/, 'expected fn fresnelSchlick to be defined');

    const fsMainStart = mainShaderSource.indexOf('fn fs_main(');
    assert.ok(fsMainStart >= 0, 'expected an fn fs_main');
    const fsMainBody = mainShaderSource.slice(fsMainStart);

    // The three terms are combined inside surfaceSpecular (specular.wgsl.ts),
    // which fs_main calls; assert the call reaches fs_main's own body, not
    // just that surfaceSpecular exists somewhere in the concatenated source.
    assert.match(fsMainBody, /surfaceSpecular\(/, 'expected fs_main to call surfaceSpecular(...)');
    assert.match(mainShaderSource, /D\s*=\s*distributionGGX\(/, 'expected distributionGGX to feed the specular lobe');
    assert.match(mainShaderSource, /G\s*=\s*geometrySmith\(/, 'expected geometrySmith to feed the specular lobe');
    assert.match(mainShaderSource, /F\s*=\s*fresnelSchlick\(/, 'expected fresnelSchlick to feed the specular lobe');
  });

  it('reads uniforms.metallicRoughness in fs_main, not just in the Uniforms struct', () => {
    const fsMainStart = mainShaderSource.indexOf('fn fs_main(');
    const fsMainBody = mainShaderSource.slice(fsMainStart);
    assert.match(
      fsMainBody,
      /uniforms\.metallicRoughness\.(x|y)/,
      'expected fs_main to read uniforms.metallicRoughness',
    );
    assert.match(fsMainBody, /uniforms\.metallicRoughness\.x/, 'expected a metallic read');
    assert.match(fsMainBody, /uniforms\.metallicRoughness\.y/, 'expected a roughness read');
  });

  it('has removed the fake glass branch (glassShine, the fixed reflection tint, edge desaturation)', () => {
    assert.doesNotMatch(mainShaderSource, /glassShine/, 'the fake constant glass shine is back');
    assert.doesNotMatch(mainShaderSource, /reflectionTint/, 'the fixed near-white reflection tint is back');
    assert.doesNotMatch(mainShaderSource, /edgeDesaturation/, 'the grey edge-desaturation mix is back');
    // Positive: the replacement lives in specular.wgsl.ts and is reached from
    // fs_main via surfaceSpecular, asserted above — restated here so this
    // test is not just a list of doesNotMatch checks with nothing shown to
    // exist in their place.
    assert.match(mainShaderSource, /surfaceSpecular\(/, 'expected the physically based lobe to replace it');
  });

  it('skips the specular term for the selection highlight and colour-override overlays', () => {
    // `mainShaderSource` contains TWO occurrences of "surfaceSpecular(": the
    // function definition (in the inlined specular.wgsl.ts) and fs_main's
    // call. Only the CALL matters here, so search from fs_main's body.
    const fsMainStart = mainShaderSource.indexOf('fn fs_main(');
    const fsMainBody = mainShaderSource.slice(fsMainStart);
    const specStart = fsMainBody.indexOf('surfaceSpecular(');
    assert.ok(specStart >= 0, 'expected fs_main to call surfaceSpecular(');
    // Walk backward from the call to the nearest enclosing `if`, and require
    // it gates on both !isSelected and !isOverlay — the same two flags the
    // selection-highlight and emphasized-overlay branches above it test.
    const before = fsMainBody.slice(0, specStart);
    const ifStart = before.lastIndexOf('if (!isSelected && !isOverlay)');
    assert.ok(ifStart >= 0, 'expected surfaceSpecular to be reached only inside `if (!isSelected && !isOverlay)`');
    // Guard the guard: confirm nothing closes that block before the call —
    // i.e. no unmatched `}` between the if and the call.
    const between = fsMainBody.slice(ifStart, specStart);
    const opens = (between.match(/{/g) ?? []).length;
    const closes = (between.match(/}/g) ?? []).length;
    assert.ok(opens > closes, 'the specular call is not still inside the isSelected/isOverlay guard');
  });

  it('scales the sun specular lobe by the same env.sunColor * env.sunIntensity * sunShadow and IRRADIANCE_CALIBRATION as the diffuse sun term', () => {
    // Diffuse sun term, for comparison.
    assert.match(
      mainShaderSource,
      /env\.sunColor \* \(diffuseSun \* sunShadow\)/,
      'expected the diffuse sun term to be env.sunColor * (diffuseSun * sunShadow)',
    );
    // The specular call is handed the same three factors as its sunLight argument.
    assert.match(
      mainShaderSource,
      /env\.sunColor \* \(env\.sunIntensity \* sunShadow\)/,
      'expected surfaceSpecular to be scaled by env.sunColor * env.sunIntensity * sunShadow',
    );
    // Both the diffuse irradiance and the specular reflection are exposed by
    // the same env.exposure * IRRADIANCE_CALIBRATION factor.
    const exposureUses = [...mainShaderSource.matchAll(/env\.exposure \* IRRADIANCE_CALIBRATION/g)];
    assert.ok(
      exposureUses.length >= 2,
      `expected env.exposure * IRRADIANCE_CALIBRATION to scale both the diffuse irradiance and the ` +
        `specular reflection, found ${exposureUses.length} use(s)`,
    );
  });

  it('clamps roughness away from zero to avoid a sub-pixel firefly peak', () => {
    assert.match(mainShaderSource, /MIN_SPECULAR_ROUGHNESS/, 'expected a minimum roughness clamp constant');
    assert.match(
      mainShaderSource,
      /clamp\(roughnessIn, MIN_SPECULAR_ROUGHNESS, 1\.0\)/,
      'expected the lobe roughness to be clamped to [MIN_SPECULAR_ROUGHNESS, 1.0]',
    );
  });

  it('mixes F0 toward albedo by metallic, using 0.04 for dielectrics', () => {
    assert.match(mainShaderSource, /DIELECTRIC_F0:\s*f32\s*=\s*0\.04/, 'expected the dielectric F0 constant to be 0.04');
    assert.match(
      mainShaderSource,
      /mix\(vec3<f32>\(DIELECTRIC_F0\), albedo, metallic\)/,
      'expected F0 to be mixed from the dielectric base toward albedo by metallic',
    );
  });

  it('guards the half-vector so a sun exactly opposite the eye reflection cannot normalize(0) into NaN', () => {
    // N = V = (0,-1,0), sun = (0,1,0): NdotV = dot(N,V) = 1 > 0 passes the
    // early back-face return above, but V + L = V + sunDirection = 0, and
    // normalize(vec3(0)) is NaN in WGSL. NaN * 0 is NaN, not 0, so the old
    // code (H computed unconditionally, NdotL only clamping the RESULT to
    // zero) let that NaN poison `sun` and everything summed with it, even
    // though this face is one the sun is behind and should contribute
    // nothing to the direct lobe. Guard the guard: rawNdotL <= 0 is exactly
    // the condition under which V + L can be zero, given NdotV > 0 already
    // holds (V = -L implies NdotL = dot(N,L) = -dot(N,V) = -NdotV < 0), so
    // gating on it is sufficient, not merely a hopeful correlation.
    // Guard the guard: the OLD code computed H right after the CLAMPED
    // NdotL, unconditionally — assert that adjacency is gone, so a revert
    // to the unconditional form (with the guard added elsewhere, vacuously)
    // cannot pass this test.
    assert.doesNotMatch(
      mainShaderSource,
      /let NdotL = max\(dot\(N, L\), 0\.0\);\s*\n\s*let H = normalize\(V \+ L\);/,
      'expected the half-vector to no longer be computed unconditionally right after NdotL',
    );
    const specStart = mainShaderSource.indexOf('fn surfaceSpecular(');
    assert.ok(specStart >= 0, 'expected fn surfaceSpecular');
    const body = mainShaderSource.slice(specStart);
    const rawNdotLDecl = body.indexOf('let rawNdotL = dot(N, L);');
    const guardIf = body.indexOf('if (rawNdotL > 0.0) {');
    const halfVector = body.indexOf('normalize(V + L)');
    assert.ok(rawNdotLDecl >= 0, 'expected an unclamped rawNdotL = dot(N, L)');
    assert.ok(guardIf >= 0, 'expected an `if (rawNdotL > 0.0)` guard');
    assert.ok(halfVector >= 0, 'expected the half-vector normalize(V + L)');
    assert.ok(
      rawNdotLDecl < guardIf && guardIf < halfVector,
      'expected rawNdotL to be declared, then guarded, before the half-vector is computed',
    );
  });
});
