/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "How much of this element is in each zone" for one straddler (issue #2508,
 * item 1), rendered inside the properties panel's existing Zones section rather
 * than in a new home.
 *
 * Computed ON DEMAND for the selected element only: the button is the "lazy"
 * in "lazy, straddlers only". Clipping one element costs tens of microseconds,
 * but the point is that nothing clips until someone asks.
 *
 * Every number carries the BASIS it was measured on, and the legend renders
 * beside the numbers rather than in a tooltip — #2199's convention, adopted
 * whole. A zone volume derived from a net wall and one derived from a gross
 * wall are not comparable, so the label is not decoration.
 */

import { useMemo, useState } from 'react';
import { Scissors, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useZoneApportionment } from '@/hooks/useZoneApportionment';
import {
  allBasisBreakdowns,
  validEntry,
  volumeBasisLabel,
  volumeBasisRatioNote,
  VOLUME_BASIS_LEGEND,
  declaredVolumeBases,
  type BasisBreakdown,
  type QuantitySetLike,
} from '@/lib/zones';
import type { ZoneSet } from '@/lib/zones';
import { zoneSetRevision } from '@/lib/zones';

/** Refusal codes with a sentence of their own below. Anything else falls to
 *  the generic branch rather than to a blank panel. */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set([
  'no-geometry',
  'unproved-solid',
  'rescaled-by-alignment',
]);
import { resolveQuantityDisplay, formatConverted, QUANTITY_TYPE_UNIT } from '@/lib/units/display';
import { VOLUME_QUANTITY_TYPE } from '@/lib/zones';
import type { ProjectUnits } from '@ifc-lite/parser';

interface Props {
  zoneSet: ZoneSet;
  /** Federated global id — the key `zoneAssignments` and the renderer share. */
  globalId: number;
  /** The selected element's declared quantity sets, for the net/gross bases. */
  quantitySets: readonly QuantitySetLike[];
  projectUnits: ProjectUnits;
  unitDisplayOverrides: Record<string, string>;
}

/** Render a cubic-metre value in the file's declared volume unit (or the user's
 *  override), through the canonical resolver. Never hand-rolled: a
 *  millimetre-length file can still declare cubic metres, so deriving one from
 *  the other is wrong by a factor of a billion. */
function useVolumeFormatter(projectUnits: ProjectUnits, overrides: Record<string, string>) {
  return useMemo(() => {
    const entry = QUANTITY_TYPE_UNIT[VOLUME_QUANTITY_TYPE];
    const fileScale = projectUnits.resolvedForUnitType(entry?.unitType ?? 'VOLUMEUNIT')?.siScale ?? 1;
    const scale = Number.isFinite(fileScale) && fileScale > 0 ? fileScale : 1;
    return {
      /** SI cubic metres -> the file's declared volume unit. */
      siScale: scale,
      format(valueM3: number): string {
        const inFileUnit = valueM3 / scale;
        const display = resolveQuantityDisplay(inFileUnit, VOLUME_QUANTITY_TYPE, projectUnits, overrides);
        const shown = display.converted ?? inFileUnit;
        return `${formatConverted(shown)}${display.unit ? ` ${display.unit}` : ''}`;
      },
    };
  }, [projectUnits, overrides]);
}

function BasisRows({ breakdown, format }: { breakdown: BasisBreakdown; format: (v: number) => string }) {
  const note = volumeBasisRatioNote(breakdown.basis);
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline gap-2 pb-1">
        <span className="text-[11px] uppercase tracking-wide font-medium">{volumeBasisLabel(breakdown.basis)}</span>
        {breakdown.quantityName && (
          <span className="text-[11px] text-muted-foreground truncate">{breakdown.quantityName}</span>
        )}
        <span className="text-xs font-mono ml-auto">{format(breakdown.totalM3)}</span>
      </div>
      <div className="divide-y">
        {breakdown.shares.map((share) => (
          <div key={share.zoneId} className="grid grid-cols-[minmax(70px,1fr)_auto_auto] gap-2 py-1 text-sm items-baseline">
            <span className="text-muted-foreground truncate" title={share.zoneName}>{share.zoneName}</span>
            <span className="font-mono text-xs text-muted-foreground">{(share.fraction * 100).toFixed(1)}%</span>
            <span className="font-medium font-mono">{format(share.valueM3)}</span>
          </div>
        ))}
        {breakdown.outsideM3 > 0 && (
          <div className="grid grid-cols-[minmax(70px,1fr)_auto_auto] gap-2 py-1 text-sm items-baseline">
            <span className="text-muted-foreground italic truncate">in no zone</span>
            <span className="font-mono text-xs text-muted-foreground" />
            <span className="font-medium font-mono">{format(breakdown.outsideM3)}</span>
          </div>
        )}
      </div>
      {note && <p className="pt-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

export function ZoneVolumeBreakdown({ zoneSet, globalId, quantitySets, projectUnits, unitDisplayOverrides }: Props) {
  const cache = useViewerStore((s) => s.zoneApportionment);
  const { computeElement } = useZoneApportionment();
  // The refusal is keyed by WHAT it is about. A bare `useState<string | null>`
  // survives a change of `globalId` or a zone edit, so selecting a refused
  // element and then a fresh straddler showed the first one's refusal and hid
  // the second one's Split button — a dead control with an explanation for
  // somebody else's element.
  const identity = `${globalId}|${zoneSetRevision(zoneSet)}`;
  const [local, setLocal] = useState<{ key: string; refusal: string | null }>({ key: identity, refusal: null });
  const refusal = local.key === identity ? local.refusal : null;
  const volume = useVolumeFormatter(projectUnits, unitDisplayOverrides);

  const entry = validEntry(cache, zoneSet);
  const apportionment = entry?.byElement.get(globalId) ?? null;
  const cachedRefusal = entry?.refused.get(globalId) ?? null;

  const breakdowns = useMemo(() => {
    if (!apportionment) return null;
    return allBasisBreakdowns(apportionment, declaredVolumeBases(quantitySets, volume.siScale));
  }, [apportionment, quantitySets, volume.siScale]);

  const reason = cachedRefusal ?? refusal;

  if (!apportionment) {
    return (
      <div className="px-3 py-2 space-y-1">
        {reason === 'no-geometry' && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5" /> No geometry loaded for this element, so its volume cannot be split.
          </p>
        )}
        {reason === 'unproved-solid' && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5" />
            Its mesh is not a proven closed solid, so no volume can be stated for it — let alone split.
          </p>
        )}
        {reason === 'rescaled-by-alignment' && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5" />
            Federation alignment rescaled this element's model, so its proved volume no longer
            describes the geometry on screen. Re-anchor the federation on this model to split it.
          </p>
        )}
        {/* A reason with no branch of its own must still SAY something: the
            Split button is suppressed by `reason` being truthy, so an
            unhandled one would render an empty box with no way forward. */}
        {reason !== null && !KNOWN_REFUSALS.has(reason) && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5" />
            Its volume could not be split ({reason}).
          </p>
        )}
        {!reason && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              const result = computeElement(zoneSet, globalId);
              setLocal({ key: identity, refusal: result.refusal });
            }}
          >
            <Scissors className="h-3.5 w-3.5 mr-1.5" /> Split volume by zone
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="border-t">
      {apportionment.overlapping && (
        <p className="px-3 pt-2 text-[11px] text-amber-600 flex items-center gap-1.5">
          <TriangleAlert className="h-3.5 w-3.5" />
          These zones overlap each other, so the shares double-count and do not add up to the whole.
        </p>
      )}
      {breakdowns?.map((breakdown) => (
        <BasisRows key={breakdown.basis} breakdown={breakdown} format={volume.format} />
      ))}
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">{VOLUME_BASIS_LEGEND}</p>
    </div>
  );
}
