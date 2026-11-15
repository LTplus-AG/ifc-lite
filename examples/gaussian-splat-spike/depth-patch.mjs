/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export const publishedRendererHash = '1eb8d5b0edb5d9058445a1d6473d6f3f187cb7e5c778bb3841e326556cb572fc';
export const upstreamCommit = 'e3979f06848a6d04547ac7a26f844212ba569806';
// The workspace installs @luma.gl/splats@9.4.2 with patches/@luma.gl__splats@9.4.2.patch:
// the luma.gl #3619 depthConvention change, plus (#8564) an opt-in depth-interval hook
// added only as marker-delimited blocks. Historical witnesses must keep running against
// the exact bytes they were recorded with, so strip the hook blocks, verify the
// depthConvention-only renderer, then reverse those hunks and re-verify.
export const publishedShadersHash = 'd860f1d273aec09d7eb10d12710bc2edcffc0d596417ee1d0124fca780128369';
export const depthConventionRendererHash = 'b3d05fcb6bd84b6a2da4444d5d87460bca64129f5ef0f99ab6156c782c8f1fda';
export const workspacePatchedRendererHash = 'f2cb6acb22ddb79479b28a18454b565baeca8f4e425d4623f4e8374de3c353f8';
export const workspacePatchedShadersHash = 'f06eab7798dce5975f2373609006a975a9893cd4d53d6ade46d6300f5b3e1a70';
// #9018 then extended the workspace patch (GPU-owned columns, float16x2 SH). Its hunks are reverted
// exactly to recover the #8564 workspace bytes above, which then verify as before.
export const workspace9018RendererHash = 'cbf3bfc038d3c7eb93df2926af0bd8b1555bdc14fcbf376d40daeb1b2cd2e607';
export const workspace9018ShadersHash = 'b0177c1fe149a2e02638cc7cb040cd50a4b9e0c54ccb8ea2ac4725393072b4fa';
const sha256 = source => createHash('sha256').update(source).digest('hex');

/** Exact, unique replacements: any drift in the installed bytes fails the hash checks instead of passing silently. */
function revertExactly(source, hunks) {
  for (const [patched, original] of hunks) {
    if (source.split(patched).length !== 2) throw new Error('A #9018 workspace hunk is missing or repeated');
    source = source.replace(patched, () => original);
  }
  return source;
}
const RENDERER_9018 = [[
  `                // ifc-lite #9018 gpu-columns: GPU-only colours carry alpha one.
                const opacity = opacities[batchRowIndex] *
                    (colors ? colors[batchRowIndex * 4 + 3] * colorAlphaScale : 1) *
`,
  `                const opacity = opacities[batchRowIndex] *
                    colors[batchRowIndex * 4 + 3] *
                    colorAlphaScale *
`,
]];
const SHADERS_9018 = [
  [`// ifc-lite #9018 float16x2 >>>
fn splatHalfCoefficient(index : u32) -> f32 {
  let pair = unpack2x16float(bitcast<u32>(splatSphericalHarmonics[index >> 1u]));
  return select(pair.x, pair.y, (index & 1u) == 1u);
}
// <<< ifc-lite #9018 float16x2

`, ''],
  [`  // ifc-lite #9018 float16x2 >>>
  // Float32 storage holds exactly rows * (9 | 24 | 45) words. Anything else is float16x2: two halves per
  // word, row-major without per-row padding, so the stored count is the largest of 9 / 24 / 45 that fits.
  // Halves are always finite (the writer falls back to float32 otherwise), so no word is an f32 NaN.
  let shRows = max(arrayLength(&splatOpacities), 1u);
  let shWords = arrayLength(&splatSphericalHarmonics);
  var coefficientCount = shWords / shRows;
  let shFloat32 = shWords == shRows * coefficientCount &&
    (coefficientCount == 9u || coefficientCount == 24u || coefficientCount == 45u);
  if (!shFloat32) {
    let halves = (2u * shWords) / shRows;
    coefficientCount = select(select(select(0u, 9u, halves >= 9u), 24u, halves >= 24u), 45u, halves >= 45u);
  }
  // <<< ifc-lite #9018 float16x2
`, `  let coefficientCount = arrayLength(&splatSphericalHarmonics) /
    max(arrayLength(&splatOpacities), 1u);
`],
  [`    var coefficients : vec3<f32>;
    if (shFloat32) {
      coefficients = vec3<f32>(
        splatSphericalHarmonics[coefficientOffset],
        splatSphericalHarmonics[coefficientOffset + 1u],
        splatSphericalHarmonics[coefficientOffset + 2u]
      );
    } else {
      coefficients = vec3<f32>(
        splatHalfCoefficient(coefficientOffset),
        splatHalfCoefficient(coefficientOffset + 1u),
        splatHalfCoefficient(coefficientOffset + 2u)
      );
    }
`, `    let coefficients = vec3<f32>(
      splatSphericalHarmonics[coefficientOffset],
      splatSphericalHarmonics[coefficientOffset + 1u],
      splatSphericalHarmonics[coefficientOffset + 2u]
    );
`],
];
/** The installed file as the #8564 workspace patch produced it (the #9018 hunks reverted when present). */
const before9018 = (raw, hash, hunks) => (sha256(raw) === hash ? revertExactly(raw, hunks) : raw);
export const rendererBefore9018 = raw => before9018(raw, workspace9018RendererHash, RENDERER_9018);
export const shadersBefore9018 = raw => before9018(raw, workspace9018ShadersHash, SHADERS_9018);
const DEPTH_INTERVAL_BLOCK = /^[ \t]*\/\/ ifc-lite #8564 depth-interval >>>\n[\s\S]*?^[ \t]*\/\/ <<< ifc-lite #8564 depth-interval\n/gm;

/** Removes the #8564 depth-interval hook blocks; every other byte is the source they were inserted into. */
export function stripDepthIntervalHook(source) {
  return source.replace(DEPTH_INTERVAL_BLOCK, '');
}

/** The installed renderer as the depthConvention-only workspace patch produced it (the bytes the K-layer peel witness was recorded with). */
export async function readDepthConventionRenderer(id) {
  const raw = rendererBefore9018(await readFile(id, 'utf8'));
  const source = sha256(raw) === workspacePatchedRendererHash ? stripDepthIntervalHook(raw) : raw;
  const actual = sha256(source);
  if (actual !== depthConventionRendererHash) throw new Error(`Unexpected depthConvention renderer: ${actual}`);
  return source;
}

export async function readPublishedRenderer(id) {
  const raw = rendererBefore9018(await readFile(id, 'utf8'));
  let source = sha256(raw) === workspacePatchedRendererHash ? stripDepthIntervalHook(raw) : raw;
  if (sha256(source) === depthConventionRendererHash) {
    source = source.replace(/^\s*depthConvention: props\.depthConvention \?\? 'standard',\n/m, '')
      .replace(/^(\s*)if \(props\.depthConvention !== undefined\) \{\n\s*this\.setResolvedProp\('depthConvention', props\.depthConvention\);\n\s*\}\n/m, '')
      .replace(/^(\s*)const projectedDepth = (clipPositionW !== 0 \? clipPositionZ \/ clipPositionW : clipPositionZ;)\n\s*const depth = this\.props\.depthConvention === 'reverse' \? -projectedDepth : projectedDepth;/m, '$1const depth = $2');
  }
  const actual = sha256(source);
  if (actual !== publishedRendererHash) throw new Error(`Unexpected upstream renderer: ${actual}`);
  return source;
}

/** The published splat shaders; the depthConvention patch never touched them. */
export async function readPublishedShaders(id) {
  const raw = shadersBefore9018(await readFile(id, 'utf8'));
  const source = sha256(raw) === workspacePatchedShadersHash ? stripDepthIntervalHook(raw) : raw;
  const actual = sha256(source);
  if (actual !== publishedShadersHash) throw new Error(`Unexpected upstream splat shaders: ${actual}`);
  return source;
}

// Experimental upstream proposal only. Never alters installed package files.
// The identical three changes apply to published JS and current upstream TS.
export function patchDepthConvention(source) {
  const replace = (pattern, replacement) => {
    if ([...source.matchAll(new RegExp(pattern.source, 'gm'))].length !== 1) {
      throw new Error(`Upstream patch anchor is not unique: ${pattern}`);
    }
    source = source.replace(pattern, replacement);
  };
  replace(/^(\s*)sortMode: props.sortMode \?\? 'global',/m,
    "$&\n$1depthConvention: props.depthConvention ?? 'standard',");
  replace(/^(\s*)if \(props.sortMode !== undefined\) \{/m,
    "$1if (props.depthConvention !== undefined) {\n$1  this.setResolvedProp('depthConvention', props.depthConvention);\n$1}\n$&");
  replace(/^(\s*)const depth = clipPositionW !== 0 \? clipPositionZ \/ clipPositionW : clipPositionZ;/m,
    '$1const projectedDepth = clipPositionW !== 0 ? clipPositionZ / clipPositionW : clipPositionZ;\n$1const depth = this.props.depthConvention === \'reverse\' ? -projectedDepth : projectedDepth;');
  return source;
}

export function depthPatchPlugin(enabled) {
  return {
    name: 'experimental-upstream-depth-convention', enforce: 'pre',
    async load(id) {
      const path = id.replaceAll('\\', '/');
      if (path.endsWith('/splats/dist/splat-shaders.js')) return { code: await readPublishedShaders(id), map: null };
      if (!path.endsWith('/splats/dist/splat-renderer.js')) return;
      const source = await readPublishedRenderer(id);
      return { code: enabled ? patchDepthConvention(source) : source, map: null };
    },
  };
}
