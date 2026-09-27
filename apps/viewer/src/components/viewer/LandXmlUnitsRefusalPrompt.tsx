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
 * Stacked into the HUD's top-center region as a `HudNotice` (#5504, charter
 * #5478 item 22), alongside {@link GeometryModeBanner} and
 * {@link MergeLayersBanner} — mounted alongside them in `ViewportContainer`,
 * with the region's own flex-column gap keeping the three from overlapping.
 * `role="alert"` (via `HudNotice`'s `role` prop) preserves the refusal's
 * immediate announcement, unlike the other two notices' passive `role="status"`.
 */
import { useEffect, useState } from 'react';
import { Ruler, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import { LANDXML_ASSUMABLE_LINEAR_UNITS } from '@/hooks/ingest/landXmlUnitsRefusal';
import { HudItem, HudNotice } from '../viewport-ui/hud';

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
    <HudItem region="top-center" order={12}>
      <HudNotice
        role="alert"
        tone="warn"
        icon={<Ruler className="h-4 w-4" />}
        title={t('landXml.unitsPrompt.message', { fileName: refusal.fileName })}
        dismiss={{
          onClick: () => setRefusal(null),
          'aria-label': t('landXml.unitsPrompt.dismiss'),
          icon: <X className="h-3.5 w-3.5" />,
        }}
      >
        <Select value={selectedUnit} onValueChange={setSelectedUnit}>
          <SelectTrigger aria-label={t('landXml.unitsPrompt.selectLabel')} className="h-7 w-36 text-2xs">
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
          className="h-7 px-2.5 gap-1.5 text-2xs font-semibold uppercase tracking-wider"
          onClick={handleRetry}
        >
          {t('landXml.unitsPrompt.retry')}
        </Button>
      </HudNotice>
    </HudItem>
  );
}
