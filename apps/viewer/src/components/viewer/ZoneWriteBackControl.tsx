/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Get zone data out of the viewer" (issue #2508, item 3), in the panel that
 * authored the zones.
 *
 * Writes the set's assignment onto the elements as an IFC property set plus a
 * quantity set, so an export carries it. The names it writes are shown here
 * rather than only in a doc: whoever runs this is about to go looking for them
 * in another tool.
 *
 * The basis is a deliberate CHOICE, not a default that hides: a `net` breakdown
 * reconciles with the file's own NetVolume by construction, while `mesh` is the
 * one that was measured. #2199's convention says the tool labels rather than
 * decides, so both are offered and the name of the chosen one ends up in the
 * quantity set's name.
 */

import { useState } from 'react';
import { FileOutput, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useZoneWriteBack } from '@/hooks/useZoneWriteBack';
import {
  zonePropertySetName,
  zoneQuantitySetName,
  volumeBasisLabel,
  type VolumeBasis,
  type ZoneSet,
} from '@/lib/zones';

const BASES: readonly VolumeBasis[] = ['mesh', 'net', 'gross', 'unqualified'];

export function ZoneWriteBackControl({ zoneSet }: { zoneSet: ZoneSet }) {
  const [basis, setBasis] = useState<VolumeBasis>('mesh');
  const { write, remove } = useZoneWriteBack();

  return (
    <div className="space-y-1 rounded border-t pt-1.5">
      <div className="flex items-center gap-1">
        <Select value={basis} onValueChange={(v) => setBasis(v as VolumeBasis)}>
          <SelectTrigger className="h-6 w-[104px] text-[11px]" aria-label="Volume basis">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BASES.map((b) => (
              <SelectItem key={b} value={b} className="text-[11px]">{volumeBasisLabel(b)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="h-6 flex-1 text-[11px]"
          title={`Write this set's zone assignment onto the elements as ${zonePropertySetName(zoneSet.name)}`}
          onClick={() => {
            const result = write(zoneSet, basis);
            if (result.blocked === 'collab-role') {
              toast.error('Your role in this session is read-only, so nothing was written');
              return;
            }
            if (result.blocked === 'duplicate-set-name') {
              // Both set names carry the display name, so two sets sharing one
              // would write to the same place and each would clear the other's
              // numbers. Renaming is the user's call, not this run's.
              toast.error(`Another zone set is also called "${zoneSet.name}". Rename one before writing.`);
              return;
            }
            if (result.summary.written === 0) {
              toast.info('No element is in a zone of this set, so nothing was written');
              return;
            }
            const { written, withVolumes, refused } = result.summary;
            toast.success(
              `Wrote ${written.toLocaleString()} element(s): ${withVolumes.toLocaleString()} with volumes`
              + (refused > 0 ? `, ${refused.toLocaleString()} with a stated reason instead` : ''),
            );
          }}
        >
          <FileOutput className="h-3 w-3 mr-1" />
          Write to model
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={`Remove ${zonePropertySetName(zoneSet.name)} from every element of this set`}
          aria-label="Remove zone properties"
          onClick={() => {
            const { removed } = remove(zoneSet);
            if (removed === 0) toast.info('Nothing to remove for this set');
            else toast.success(`Removed the zone property set from ${removed.toLocaleString()} element(s)`);
          }}
        >
          <Undo2 className="h-3 w-3" />
        </Button>
      </div>
      {/* Named here because the next place these are looked for is another
          tool's property browser, not this panel. */}
      <p className="text-[10px] text-muted-foreground leading-snug break-words">
        {zonePropertySetName(zoneSet.name)} · {zoneQuantitySetName(zoneSet.name, basis)}
      </p>
    </div>
  );
}
