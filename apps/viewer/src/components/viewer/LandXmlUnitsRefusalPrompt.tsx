/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5175: the affordance a LandXML "no declared &lt;Units&gt;" refusal
 * (LXML009) leaves the user with. `useIfcLoader.loadFile` sets
 * `landXmlUnitsRefusal` on the loading slice ONLY when the failure message
 * matches {@link isLandXmlUnitsRefusal} — never for an unrelated LandXML
 * failure — and clears it at the start of every subsequent `loadFile` call
 * (including the retry this banner triggers).
 *
 * The unit picker starts with nothing selected and the retry button starts
 * disabled: this issue exists because the viewer must never assume a unit on
 * the user's behalf, so the UI cannot default one either.
 *
 * Mirrors {@link GeometryModeBanner}'s non-modal top-of-canvas placement,
 * mounted alongside it in `ViewportContainer`.
 */
import { useEffect, useState } from 'react';
import { Ruler, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { LANDXML_ASSUMABLE_LINEAR_UNITS } from '@/hooks/ingest/landXmlUnitsRefusal';

export function LandXmlUnitsRefusalPrompt() {
  const { t } = useTranslation();
  const refusal = useViewerStore((s) => s.landXmlUnitsRefusal);
  const setRefusal = useViewerStore((s) => s.setLandXmlUnitsRefusal);
  // Not `''`: an empty-string Select value renders as a real (wrong) choice
  // instead of the placeholder. `undefined` is "nothing chosen yet".
  const [selectedUnit, setSelectedUnit] = useState<string | undefined>(undefined);

  // The prompt stays mounted when `refusal` clears, so without this a unit
  // chosen for one file would still be selected when the NEXT file refuses —
  // arming retry before the user has chosen anything for it. That is exactly
  // the "viewer assumed a unit on your behalf" failure this feature exists to
  // prevent (#5175 review).
  useEffect(() => { setSelectedUnit(undefined); }, [refusal]);

  if (!refusal) return null;

  const handleRetry = (): void => {
    if (!selectedUnit) return;
    const retry = refusal.retry;
    setSelectedUnit(undefined);
    setRefusal(null);
    retry(selectedUnit);
  };

  return (
    <div className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 z-40 max-w-[min(640px,calc(100%-1.5rem))] w-fit">
      <div
        role="alert"
        aria-live="assertive"
        className={cn(
          'pointer-events-auto flex items-center gap-3 border border-amber-500/50 bg-background/95 backdrop-blur',
          'px-3 py-2 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)] rounded-md',
          'animate-in slide-in-from-top-2 fade-in-0 duration-200',
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Ruler className="h-4 w-4" />
        </div>
        <span className="text-xs font-medium text-foreground max-w-[280px]">
          {t('landXml.unitsPrompt.message', { fileName: refusal.fileName })}
        </span>
        <div className="flex items-center gap-1.5 ml-2">
          <Select value={selectedUnit} onValueChange={setSelectedUnit}>
            <SelectTrigger aria-label={t('landXml.unitsPrompt.selectLabel')} className="h-7 w-36 text-[11px]">
              <SelectValue placeholder={t('landXml.unitsPrompt.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {LANDXML_ASSUMABLE_LINEAR_UNITS.map((unit) => (
                <SelectItem key={unit.value} value={unit.value}>{t(unit.labelKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="default"
            disabled={!selectedUnit}
            className="h-7 px-2.5 gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
            onClick={handleRetry}
          >
            {t('landXml.unitsPrompt.retry')}
          </Button>
          <IconButton
            label={t('landXml.unitsPrompt.dismiss')}
            size="icon-sm"
            className="h-7 w-7"
            onClick={() => setRefusal(null)}
          >
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
