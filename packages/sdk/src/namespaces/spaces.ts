/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend } from '../types.js';
import type {
  GenerateSpacesAllOptions,
  GenerateSpacesAllResult,
  StoreyInfo,
} from '@ifc-lite/create';

/**
 * Derive `IfcSpace` from a model's walls (room footprints) with slab/roof-aware
 * heights. Available on local/headless contexts (direct store access); a remote
 * backend whose store lives server-side will throw.
 *
 * @example
 * const result = bim.spaces.generate({ height: 'auto', snap: 'auto' });
 * const ifc = await bim.export.toStep(); // includes the new IfcSpace
 */
export class SpacesNamespace {
  constructor(private backend: BimBackend) {}

  private impl() {
    if (!this.backend.spaces) {
      throw new Error(
        'spaces: not available on this backend — space derivation needs direct ' +
        'store access (use a headless/local context, not a remote transport).',
      );
    }
    return this.backend.spaces;
  }

  /** Every `IfcBuildingStorey` (id, name, elevation), low → high. */
  storeys(): StoreyInfo[] {
    return this.impl().listStoreys();
  }

  /**
   * Derive `IfcSpace` across the selected storeys (default: all). Footprint
   * comes from walls; `height: 'auto'` (default) uses floor-to-floor from
   * storey elevations; `snap: 'auto'` (default) escalates the corner-closing
   * tolerance. The spaces are written to the model's mutation overlay — call
   * `bim.export.toStep()` to obtain IFC bytes including them.
   */
  generate(options?: GenerateSpacesAllOptions): GenerateSpacesAllResult {
    return this.impl().generate(options);
  }
}
