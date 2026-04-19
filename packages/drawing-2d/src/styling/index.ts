/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Line styling and layer mapping for architectural drawings
 */

export { LineWeightAssigner, LINE_WEIGHT_CONFIG, IFC_TYPE_WEIGHTS } from './line-weights.js';
export { LineStyler, DASH_PATTERNS } from './line-styles.js';
export { LayerMapper, DEFAULT_LAYERS, getLayerForIfcType } from './layer-mapping.js';
