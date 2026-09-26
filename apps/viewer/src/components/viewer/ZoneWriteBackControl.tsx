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

import { useRef, useState } from 'react';
import { Box, FileOutput, Sheet, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useZoneWriteBack } from '@/hooks/useZoneWriteBack';
import { useZoneSpatialZones } from '@/hooks/useZoneSpatialZones';
import { useZoneTableExport, type ZoneTableFormat } from '@/hooks/useZoneTableExport';
import { emitRefusalText } from '@/lib/zones/emit-spatial-zones';
import {
  zonePropertySetName,
  zoneQuantitySetName,
  volumeBasisLabel,
  type VolumeBasis,
  type ZoneSet,
} from '@/lib/zones';

const BASES: readonly VolumeBasis[] = ['mesh', 'net', 'gross', 'unqualified'];

export function ZoneWriteBackControl({ zoneSet }: { zoneSet: ZoneSet }) {
  const { t } = useTranslation();
  const [basis, setBasis] = useState<VolumeBasis>('mesh');
  const { write, remove } = useZoneWriteBack();
  const { emit: emitZones, remove: removeZones } = useZoneSpatialZones();
  const { exportTable } = useZoneTableExport();
  // A table export gathers every element and may recompute the apportionment,
  // so a second click while the first runs pays for two full gathers and
  // downloads the same file twice.
  //
  // A REF as well as the state, and the ref is what guards: state has not
  // re-rendered yet in the tick the first click starts, so a double click would
  // pass a state-only check and disable a button that is already too late. The
  // state exists only to say so in the UI. Same pairing, for the same reason,
  // as the geometry export in `ZonesPanel`.
  const exportingTableRef = useRef(false);
  const [exportingTable, setExportingTable] = useState<ZoneTableFormat | null>(null);

  const runTableExport = async (format: ZoneTableFormat) => {
    if (exportingTableRef.current) return;
    exportingTableRef.current = true;
    setExportingTable(format);
    try {
      const result = await exportTable(zoneSet, basis, format);
      if (result.blocked === 'no-members') {
        toast.info(t('zonesPanel.writeBack.noMembersTableMessage'));
        return;
      }
      // Said rather than left to be discovered by summing a column.
      toast.success(
        result.unmeasured > 0
          ? t('zonesPanel.writeBack.tableExportSuccessUnmeasured', {
              rows: result.rows.toLocaleString(),
              elements: result.elements.toLocaleString(),
              unmeasured: result.unmeasured.toLocaleString(),
            })
          : t('zonesPanel.writeBack.tableExportSuccess', {
              rows: result.rows.toLocaleString(),
              elements: result.elements.toLocaleString(),
            }),
      );
    } catch (error) {
      // Parquet loads its wasm writer on demand, so this is the one export here
      // that can fail for a reason outside the model.
      console.error('[zones] table export failed', error);
      toast.error(t('zonesPanel.writeBack.tableExportError', { message: error instanceof Error ? error.message : 'unknown error' }));
    } finally {
      // In a `finally` so a Parquet writer that fails to load does not leave
      // both buttons dead for the rest of the session.
      exportingTableRef.current = false;
      setExportingTable(null);
    }
  };

  return (
    <div className="space-y-1 rounded border-t pt-1.5">
      <div className="flex items-center gap-1">
        <Select value={basis} onValueChange={(v) => setBasis(v as VolumeBasis)}>
          <SelectTrigger className="h-6 w-[104px] text-[11px]" aria-label={t('zonesPanel.writeBack.volumeBasisAriaLabel')}>
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
          title={t('zonesPanel.writeBack.writeButtonTitle', { psetName: zonePropertySetName(zoneSet.name) })}
          onClick={() => {
            const result = write(zoneSet, basis);
            if (result.blocked === 'collab-role') {
              toast.error(t('zonesPanel.writeBack.collabReadOnlyWrite'));
              return;
            }
            if (result.blocked === 'duplicate-set-name') {
              // Both set names carry the display name, so two sets sharing one
              // would write to the same place and each would clear the other's
              // numbers. Renaming is the user's call, not this run's.
              toast.error(t('zonesPanel.writeBack.duplicateSetNameWrite', { name: zoneSet.name }));
              return;
            }
            if (result.summary.written === 0) {
              toast.info(t('zonesPanel.writeBack.noMembersWrite'));
              return;
            }
            const { written, withVolumes, refused } = result.summary;
            toast.success(
              refused > 0
                ? t('zonesPanel.writeBack.writeSuccessRefused', {
                    written: written.toLocaleString(),
                    withVolumes: withVolumes.toLocaleString(),
                    refused: refused.toLocaleString(),
                  })
                : t('zonesPanel.writeBack.writeSuccess', {
                    written: written.toLocaleString(),
                    withVolumes: withVolumes.toLocaleString(),
                  }),
            );
          }}
        >
          <FileOutput className="h-3 w-3 mr-1" />
          {t('zonesPanel.writeBack.writeButtonLabel')}
        </Button>
        <IconButton
          label={t('zonesPanel.writeBack.removePropsAriaLabel')}
          tooltip={t('zonesPanel.writeBack.removePropsTitle', { psetName: zonePropertySetName(zoneSet.name) })}
          className="h-6 w-6"
          onClick={() => {
            const { removed, blocked } = remove(zoneSet);
            if (blocked === 'collab-role') {
              toast.error(t('zonesPanel.writeBack.collabReadOnlyRemove'));
              return;
            }
            if (blocked === 'duplicate-set-name') {
              toast.error(t('zonesPanel.writeBack.duplicateSetNameRemove', { name: zoneSet.name }));
              return;
            }
            if (removed === 0) toast.info(t('zonesPanel.writeBack.nothingToRemove'));
            else toast.success(t('zonesPanel.writeBack.removeSuccess', { removed: removed.toLocaleString() }));
          }}
        >
          <Undo2 className="h-3 w-3" />
        </IconButton>
      </div>
      {/* Named here because the next place these are looked for is another
          tool's property browser, not this panel. */}
      <p className="text-[10px] text-muted-foreground leading-snug break-words">
        {zonePropertySetName(zoneSet.name)} · {zoneQuantitySetName(zoneSet.name, basis)}
      </p>
      {/* The direct answer to #1763's "manual work in Excel": one row per
          (element, zone), which pivots without unpivoting first. */}
      <div className="flex items-center gap-1">
        {(['csv', 'parquet'] as const).map((format) => (
          <Button
            key={format}
            variant="outline"
            size="sm"
            className="h-6 flex-1 text-[11px]"
            disabled={exportingTable !== null}
            title={t('zonesPanel.writeBack.downloadTableTitle', { format: format.toUpperCase() })}
            onClick={() => { void runTableExport(format); }}
          >
            <Sheet className="h-3 w-3 mr-1" />
            {exportingTable === format ? t('zonesPanel.writeBack.buildingLabel') : format.toUpperCase()}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-6 flex-1 text-[11px]"
          title={t('zonesPanel.writeBack.emitZonesTitle')}
          onClick={() => {
            const result = emitZones(zoneSet);
            if (result.blocked === 'collab-role') {
              toast.error(t('zonesPanel.writeBack.collabReadOnlyEmit'));
              return;
            }
            if (result.blocked === 'no-members') {
              toast.info(
                result.staleRemoved > 0
                  ? t('zonesPanel.writeBack.staleRemovedOnly', { staleRemoved: result.staleRemoved.toLocaleString() })
                  : t('zonesPanel.writeBack.noMembersEmit'),
              );
              return;
            }
            if (result.blocked === 'duplicate-set-name') {
              // The set's name is what identifies its zones in the FILE, so two
              // sets sharing one would each delete the other's on the next run.
              toast.error(t('zonesPanel.writeBack.duplicateSetNameEmit', { name: zoneSet.name }));
              return;
            }
            const written = result.models.filter((m) => m.zonesEmitted > 0);
            // Every refused model is named, rather than folded into a count: in
            // a federation the answer "which file did NOT get the zones" is the
            // one the user has to act on.
            const refused = result.models.filter((m) => m.refusal);
            for (const model of refused) {
              toast.error(emitRefusalText(model.refusal as NonNullable<typeof model.refusal>, model.modelName));
            }
            if (written.length === 0) {
              // A model with no parsed store is skipped without a refusal, so
              // without this the click produces no feedback at all.
              if (refused.length === 0) toast.info(t('zonesPanel.writeBack.noModelForZones'));
              return;
            }
            const zones = written.reduce((sum, m) => sum + m.zonesEmitted, 0);
            const elements = written.reduce((sum, m) => sum + m.elementsReferenced, 0);
            const replaced = written.reduce((sum, m) => sum + m.zonesReplaced, 0);
            const successKey: TranslationKey = replaced > 0 && result.staleRemoved > 0
              ? 'zonesPanel.writeBack.emitSuccessReplacedStale'
              : replaced > 0
                ? 'zonesPanel.writeBack.emitSuccessReplaced'
                : result.staleRemoved > 0
                  ? 'zonesPanel.writeBack.emitSuccessStale'
                  : 'zonesPanel.writeBack.emitSuccess';
            toast.success(
              t(successKey, {
                zones: zones.toLocaleString(),
                models: written.length,
                elements: elements.toLocaleString(),
                replaced: replaced.toLocaleString(),
                staleRemoved: result.staleRemoved.toLocaleString(),
              }),
            );
          }}
        >
          <Box className="h-3 w-3 mr-1" />
          {t('zonesPanel.writeBack.emitZonesLabel')}
        </Button>
        <IconButton
          label={t('zonesPanel.writeBack.removeEmittedAriaLabel')}
          tooltip={t('zonesPanel.writeBack.removeEmittedTitle')}
          className="h-6 w-6"
          onClick={() => {
            const { removed, blocked } = removeZones(zoneSet);
            if (blocked === 'collab-role') {
              toast.error(t('zonesPanel.writeBack.collabReadOnlyRemove'));
              return;
            }
            if (blocked === 'duplicate-set-name') {
              toast.error(t('zonesPanel.writeBack.duplicateSetNameRemove', { name: zoneSet.name }));
              return;
            }
            if (removed === 0) toast.info(t('zonesPanel.writeBack.removeEmittedNone'));
            else toast.success(t('zonesPanel.writeBack.removeEmittedSuccess', { removed: removed.toLocaleString() }));
          }}
        >
          <Undo2 className="h-3 w-3" />
        </IconButton>
      </div>
    </div>
  );
}
