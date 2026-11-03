/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export const publishedRendererHash = '1eb8d5b0edb5d9058445a1d6473d6f3f187cb7e5c778bb3841e326556cb572fc';
export const upstreamCommit = 'e3979f06848a6d04547ac7a26f844212ba569806';
// The workspace installs @luma.gl/splats@9.4.2 with patches/@luma.gl__splats@9.4.2.patch
// (the same luma.gl #3619 change, #8564). Historical witnesses must keep running
// against the exact published bytes, so reverse only those hunks and re-verify.
export const workspacePatchedRendererHash = 'b3d05fcb6bd84b6a2da4444d5d87460bca64129f5ef0f99ab6156c782c8f1fda';
const sha256 = source => createHash('sha256').update(source).digest('hex');
export async function readPublishedRenderer(id) {
  let source = await readFile(id, 'utf8');
  if (sha256(source) === workspacePatchedRendererHash) {
    source = source.replace(/^\s*depthConvention: props\.depthConvention \?\? 'standard',\n/m, '')
      .replace(/^(\s*)if \(props\.depthConvention !== undefined\) \{\n\s*this\.setResolvedProp\('depthConvention', props\.depthConvention\);\n\s*\}\n/m, '')
      .replace(/^(\s*)const projectedDepth = (clipPositionW !== 0 \? clipPositionZ \/ clipPositionW : clipPositionZ;)\n\s*const depth = this\.props\.depthConvention === 'reverse' \? -projectedDepth : projectedDepth;/m, '$1const depth = $2');
  }
  const actual = sha256(source);
  if (actual !== publishedRendererHash) throw new Error(`Unexpected upstream renderer: ${actual}`);
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
      if (!id.replaceAll('\\', '/').endsWith('/splats/dist/splat-renderer.js')) return;
      const source = await readPublishedRenderer(id);
      return { code: enabled ? patchDepthConvention(source) : source, map: null };
    },
  };
}
