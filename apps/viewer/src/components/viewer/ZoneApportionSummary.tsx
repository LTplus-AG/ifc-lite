/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The whole-set entry point for volume apportionment (issue #2508): clip every
 * straddler of one zone set, once, on an explicit click.
 *
 * This is what fills the cache the `Zone > Volume` list columns read, so the
 * Lists table and the properties panel are never two computations that can
 * disagree — they are two readers of one result, keyed by the zone-set revision
 * that produced it.
 *
 * It also answers #2508's "elements with no geometry are silently unclassified"
 * note in the only place a total is stated: a count that quietly omits elements
 * is worse than one that says how many it omitted, and WHY — the two refusal
 * reasons are different modelling problems with different fixes.
 */

import { Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useZoneApportionment, straddlerIdsFor } from '@/hooks/useZoneApportionment';
import { coverageOf, validEntry, type ZoneSet } from '@/lib/zones';

export function ZoneApportionSummary({ zoneSet }: { zoneSet: ZoneSet }) {
  const cache = useViewerStore((s) => s.zoneApportionment);
  const assignments = useViewerStore((s) => s.zoneAssignments);
  const { computeSet } = useZoneApportionment();

  const entry = validEntry(cache, zoneSet);
  const coverage = coverageOf(entry);
  // Recomputed off `assignments` so the count tracks v1's classification rather
  // than a stale snapshot — the same map the straddle flag itself comes from.
  void assignments;
  const straddlers = straddlerIdsFor(zoneSet.id).length;

  return (
    <div className="space-y-1 rounded border-t pt-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-full text-[11px]"
        disabled={straddlers === 0}
        title={straddlers === 0
          ? 'No element crosses a boundary in this set, so there is nothing to split'
          : `Split the volume of ${straddlers} straddling element(s) across this set's zones`}
        // One SYNCHRONOUS pass (~50 us per element, ~11 ms over 241 straddlers).
        // There was a `running` flag with a spinner here; it could never be
        // seen. React batches the set-true and set-false inside one handler, so
        // the browser never painted between them — and because the handler
        // blocks, there is no window for a second click to land in either. A
        // control that shows progress it cannot have is worse than one that
        // simply completes.
        onClick={() => computeSet(zoneSet)}
      >
        <Scissors className="h-3 w-3 mr-1" />
        Split volumes ({straddlers} straddler{straddlers === 1 ? '' : 's'})
      </Button>
      {entry && (
        <p className="text-[10px] text-muted-foreground leading-snug">
          {coverage.apportioned.toLocaleString()} split in {entry.elapsedMs.toFixed(0)} ms
          {coverage.unprovedSolid > 0 && ` · ${coverage.unprovedSolid} skipped (mesh not a proven closed solid)`}
          {coverage.noGeometry > 0 && ` · ${coverage.noGeometry} skipped (no geometry loaded)`}
          {/* Its own clause, not folded into "not a proven closed solid": the
              kernel DID prove these, and the fix is to re-anchor the federation
              rather than to look at the element's geometry. */}
          {coverage.rescaledByAlignment > 0 && ` · ${coverage.rescaledByAlignment} skipped (model rescaled by federation alignment)`}
        </p>
      )}
    </div>
  );
}
