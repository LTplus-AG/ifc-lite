/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractLengthUnitScale, extractProjectUnits } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { formatQuantityUnit } from '@/lib/units/display';
import { resolveRef } from './refs.js';
import type { ModelTool } from './types.js';

/** Units and quantity-set measures. All of them read the project's declared units from the STEP source. */
export const measureTools: Record<'units' | 'geometry_bbox' | 'geometry_volume' | 'geometry_area', ModelTool> = {
  units: {
    needs: 'source',
    async run(_host, m) {
      const scale = m.store.source && m.store.entityIndex
        ? extractLengthUnitScale(m.store.source, m.store.entityIndex)
        : 1.0;
      return {
        text: `Length unit scale: ${scale} (lengths × ${scale} → metres). Schema: ${m.store.schemaVersion}.`,
        structured: { lengthUnitScale: scale, schema: m.store.schemaVersion },
      };
    },
  },

  // ── Geometry (read from quantity sets) ──────────────────────────────────
  geometry_bbox: {
    needs: 'source',
    async run(_host, m, args) {
      const ref = resolveRef(m, args);
      const qsets = m.bim.quantities(ref);
      return { text: 'Bounding-box derived from quantity sets when available; full WASM geometry is v0.2.', structured: { quantitySets: qsets } };
    },
  },

  geometry_volume: {
    needs: 'source',
    async run(_host, m, args) {
      const ref = resolveRef(m, args);
      const qsets = m.bim.quantities(ref);
      let vol: number | null = null;
      for (const q of qsets) for (const x of q.quantities) if (/Volume/i.test(x.name) && typeof x.value === 'number') { vol = x.value; break; }
      // Label with the file's declared VOLUMEUNIT (issue #1573) rather than
      // assuming m³ — the quantity value is stored in whatever unit the
      // project declares.
      const unit = m.store.source.length > 0
        ? formatQuantityUnit(QuantityType.Volume, extractProjectUnits(m.store.source, m.store.entityIndex))
        : 'm³';
      return { text: vol == null ? 'No Volume quantity present.' : `Volume = ${vol.toFixed(3)} ${unit}.`, structured: { volume: vol, unit } };
    },
  },

  geometry_area: {
    needs: 'source',
    async run(_host, m, args) {
      const ref = resolveRef(m, args);
      const qsets = m.bim.quantities(ref);
      let area: number | null = null;
      for (const q of qsets) for (const x of q.quantities) if (/Area/i.test(x.name) && typeof x.value === 'number') { area = x.value; break; }
      const unit = m.store.source.length > 0
        ? formatQuantityUnit(QuantityType.Area, extractProjectUnits(m.store.source, m.store.entityIndex))
        : 'm²';
      return { text: area == null ? 'No Area quantity present.' : `Area = ${area.toFixed(3)} ${unit}.`, structured: { area, unit } };
    },
  },
};
