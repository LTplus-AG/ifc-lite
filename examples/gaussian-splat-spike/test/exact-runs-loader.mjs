// SPDX-License-Identifier: MPL-2.0

let transform;

export function initialize(data) {
  transform = data;
}

// Keep the real module URL so the transformed renderer resolves its normal imports.
export function load(url, context, nextLoad) {
  if (url !== transform.target) return nextLoad(url, context);
  return { format: 'module', source: transform.source, shortCircuit: true };
}
