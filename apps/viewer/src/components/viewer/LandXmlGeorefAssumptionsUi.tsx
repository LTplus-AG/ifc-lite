/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The UI for the two LandXML georeferencing assumptions that relax the
 * fail-closed CRS rules (#5048) when a LandXML is placed on a georeferenced
 * model: the refusal prompt, the Settings group, and the "Assumed" notice.
 * All three describe an assumption with the same words.
 *
 * One lazy module, loaded by `LandXmlGeorefAssumptionsLazy.tsx` only when
 * there is something to show, so neither this code nor its catalogue is in
 * the eager bundle. Components that already live in the entry chunk (HUD
 * notice, checkbox, Settings layout) are passed in as props rather than
 * imported; see that file for why.
 */

import '@/i18n/catalogues/landxml-georef-assumptions.register';
import { useEffect, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import type { Checkbox as CheckboxComponent } from '@/components/ui/checkbox';
import {
  LANDXML_GEOREF_ASSUMPTION_ORDER as ORDER,
  type LandXmlGeorefAssumption,
  type LandXmlGeorefAssumptions,
} from '@/hooks/ingest/landXmlGeorefAssumptions';
import type { FederatedModel } from '@/store';
import type { HudNotice as HudNoticeComponent } from '../viewport-ui/hud';
import type { SettingsGroup as SettingsGroupComponent, SettingsRow as SettingsRowComponent } from './settings/SettingsGroup';

const label = (a: LandXmlGeorefAssumption) => `landXmlGeorefAssumptions.${a}.label` as const;
const description = (a: LandXmlGeorefAssumption) => `landXmlGeorefAssumptions.${a}.description` as const;

type Checked = Partial<Record<LandXmlGeorefAssumption, boolean>>;

function allOffered(offer: readonly LandXmlGeorefAssumption[]): Checked {
  return Object.fromEntries(offer.map((assumption) => [assumption, true]));
}

/**
 * What a federated LandXML that could not be aligned leaves the user with,
 * when one or more assumptions WOULD align it (`landXmlAssumptionRefusal.offer`).
 * Modelled on #5175's `LandXmlUnitsRefusalPrompt`: the loader's refusal
 * message verbatim (it names what the files do not declare), then one
 * pre-checked box per offered assumption, saying what it assumes and what
 * goes wrong if it does not hold.
 *
 * "Load with these assumptions" retries with exactly the checked ones (every
 * other assumption off); "Always assume this" also turns the checked ones on
 * in Settings first; Cancel clears the refusal. Nothing is assumed without
 * one of those clicks.
 */
export function LandXmlAssumptionRefusalPrompt({ HudNotice, Checkbox }: {
  HudNotice: typeof HudNoticeComponent;
  Checkbox: typeof CheckboxComponent;
}) {
  const { t } = useTranslation();
  const refusal = useViewerStore((s) => s.landXmlAssumptionRefusal);
  const setRefusal = useViewerStore((s) => s.setLandXmlAssumptionRefusal);
  const setSettings = useViewerStore((s) => s.setLandXmlGeorefAssumptionSettings);
  const [checked, setChecked] = useState<Checked>(() => allOffered(refusal?.offer ?? []));
  const firstControl = useRef<HTMLInputElement>(null);
  const alwaysHintId = useId();

  // A new refusal (another file) starts from its own offer, all pre-checked,
  // never from the previous file's choice; and focus moves to it, since the
  // load the user just started now waits on this decision.
  useEffect(() => {
    setChecked(allOffered(refusal?.offer ?? []));
    if (refusal) firstControl.current?.focus();
  }, [refusal]);

  if (!refusal || refusal.offer.length === 0) return null;

  const offered = ORDER.filter((assumption) => refusal.offer.includes(assumption));
  const chosen = offered.filter((assumption) => checked[assumption]);
  // `retry` takes the COMPLETE set for the new attempt: what is not checked is off.
  const choice: LandXmlGeorefAssumptions = {
    sharedVerticalDatum: chosen.includes('sharedVerticalDatum'),
    epsgFromName: chosen.includes('epsgFromName'),
  };

  const load = (persist: boolean): void => {
    if (chosen.length === 0) return;
    const retry = refusal.retry;
    if (persist) setSettings(Object.fromEntries(chosen.map((assumption) => [assumption, true])));
    setRefusal(null);
    retry(choice);
  };

  return (
    <HudNotice
      role="alert"
      tone="warn"
      icon={<TriangleAlert className="h-4 w-4" />}
      title={t('landXmlGeorefAssumptions.title', { fileName: refusal.fileName })}
      className="max-w-xl"
      description={
        <div className="space-y-2">
          <p className="whitespace-pre-line">{refusal.message}</p>
          <p className="font-medium text-overlay-ink">{t('landXmlGeorefAssumptions.offer')}</p>
          {offered.map((assumption, index) => (
            <Checkbox
              key={assumption}
              ref={index === 0 ? firstControl : undefined}
              checked={checked[assumption] === true}
              onCheckedChange={(next) => setChecked((current) => ({ ...current, [assumption]: next }))}
              label={t(label(assumption))}
              description={t(description(assumption))}
              data-assumption={assumption}
            />
          ))}
          <p id={alwaysHintId}>{t('landXmlGeorefAssumptions.alwaysHint')}</p>
        </div>
      }
    >
      <Button size="sm" variant="default" disabled={chosen.length === 0} className="h-7 px-2.5 text-2xs font-semibold" onClick={() => load(false)}>
        {t('landXmlGeorefAssumptions.load')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={chosen.length === 0}
        className="h-7 px-2.5 text-2xs"
        aria-describedby={alwaysHintId}
        onClick={() => load(true)}
      >
        {t('landXmlGeorefAssumptions.always')}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2.5 text-2xs" onClick={() => setRefusal(null)}>
        {t('landXmlGeorefAssumptions.cancel')}
      </Button>
    </HudNotice>
  );
}

/**
 * Settings → General → LandXML georeferencing: the standing choice, both off
 * by default, bound to the persisted `landXmlGeorefAssumptionSettings` (the
 * same setting the prompt's "Always assume this" writes).
 */
export function LandXmlGeorefSettingsGroup({ SettingsGroup, SettingsRow }: {
  SettingsGroup: typeof SettingsGroupComponent;
  SettingsRow: typeof SettingsRowComponent;
}) {
  const { t } = useTranslation();
  const settings = useViewerStore((s) => s.landXmlGeorefAssumptionSettings);
  const setSettings = useViewerStore((s) => s.setLandXmlGeorefAssumptionSettings);
  return (
    <SettingsGroup title={t('landXmlGeorefAssumptions.settings')}>
      <p className="text-xs text-muted-foreground">{t('landXmlGeorefAssumptions.settingsHint')}</p>
      {ORDER.map((assumption) => {
        const id = `settings-landxml-${assumption}`;
        return (
          <SettingsRow key={assumption} label={t(label(assumption))} hint={t(description(assumption))} htmlFor={id}>
            <Switch id={id} checked={settings[assumption]} onCheckedChange={(on) => setSettings({ [assumption]: on })} />
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * The "Assumed" notice on a model placed under an assumption the user chose
 * (`FederatedModel.landXmlAssumptionsApplied`): one line per assumption, in
 * words, so such a placement never reads like one that rests on declared
 * CRSs. An EPSG code read from the name is the model's horizontal CRS id.
 */
export function LandXmlAssumptionsNotice({ model }: { model: FederatedModel }) {
  const { t } = useTranslation();
  const applied = model.landXmlAssumptionsApplied ?? [];
  const crs = model.spatialReference?.horizontal?.id ?? '';
  return (
    <section
      className="border-b border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
      data-landxml-assumptions
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="rounded border border-amber-400 px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide dark:border-amber-700">
          {t('landXmlGeorefAssumptions.badge')}
        </span>
        <h4 className="font-semibold">{t('landXmlGeorefAssumptions.assumed')}</h4>
      </div>
      <ul className="mt-1.5 list-disc space-y-1 pl-6">
        {ORDER.filter((assumption) => applied.includes(assumption)).map((assumption) => (
          <li key={assumption}>{t(`landXmlGeorefAssumptions.${assumption}.applied`, { crs })}</li>
        ))}
      </ul>
    </section>
  );
}
