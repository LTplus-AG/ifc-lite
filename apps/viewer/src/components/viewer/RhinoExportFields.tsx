/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The option controls and progress row of `RhinoExportDialog`. Presentational:
 * the dialog owns the settings and the export.
 */

import type { Rhino3dmVersion } from '@ifc-lite/rhino3dm';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatLocaleNumber, useTranslation } from '@/i18n';
import type { RhinoExportProgress } from '@/lib/export/rhino-export-client';
import {
  RHINO_3DM_VERSIONS,
  RHINO_COORDINATES,
  RHINO_LAYER_SCHEMES,
  RHINO_PROPERTIES,
  RHINO_UNITS,
  type RhinoExportSettings,
} from './rhino-export-options';

interface SelectRowProps<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  labelOf: (value: T) => string;
  onChange: (value: T) => void;
  disabled: boolean;
  hint?: string;
}

function SelectRow<T extends string>({ label, value, options, labelOf, onChange, disabled, hint }: SelectRowProps<T>) {
  return (
    <div className="flex items-start gap-4">
      <Label className="w-32 pt-2">{label}</Label>
      <div className="flex-1 space-y-1">
        <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
          <SelectTrigger aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>{labelOf(option)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function SwitchRow({ label, hint, checked, onChange, disabled }: {
  label: string; hint: string; checked: boolean; onChange: (next: boolean) => void; disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

export function RhinoExportFields({ settings, onChange, disabled }: {
  settings: RhinoExportSettings;
  onChange: (patch: Partial<RhinoExportSettings>) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SelectRow label={t('rhinoExport.unitsLabel')} value={settings.units} options={RHINO_UNITS}
        labelOf={(v) => t(`rhinoExport.units.${v}`)} onChange={(units) => onChange({ units })} disabled={disabled} />
      <SelectRow label={t('rhinoExport.layerSchemeLabel')} value={settings.layerScheme} options={RHINO_LAYER_SCHEMES}
        labelOf={(v) => t(`rhinoExport.layerScheme.${v}`)} onChange={(layerScheme) => onChange({ layerScheme })} disabled={disabled} />
      <SelectRow label={t('rhinoExport.propertiesLabel')} value={settings.properties} options={RHINO_PROPERTIES}
        labelOf={(v) => t(`rhinoExport.properties.${v}`)} onChange={(properties) => onChange({ properties })} disabled={disabled} />
      <SelectRow label={t('rhinoExport.coordinatesLabel')} value={settings.coordinates} options={RHINO_COORDINATES}
        labelOf={(v) => t(`rhinoExport.coordinates.${v}`)} onChange={(coordinates) => onChange({ coordinates })} disabled={disabled}
        hint={t('rhinoExport.coordinatesHint')} />
      <SelectRow label={t('rhinoExport.versionLabel')} value={String(settings.version) as `${Rhino3dmVersion}`}
        options={RHINO_3DM_VERSIONS.map((v) => String(v) as `${Rhino3dmVersion}`)}
        labelOf={(v) => t(`rhinoExport.version.${v}`)}
        onChange={(v) => onChange({ version: Number(v) as Rhino3dmVersion })} disabled={disabled} />
      <SwitchRow label={t('rhinoExport.instancingLabel')} hint={t('rhinoExport.instancingHint')}
        checked={settings.instancing} onChange={(instancing) => onChange({ instancing })} disabled={disabled} />
      <SwitchRow label={t('rhinoExport.includeSpacesLabel')} hint={t('rhinoExport.includeSpacesHint')}
        checked={settings.includeSpaces} onChange={(includeSpaces) => onChange({ includeSpaces })} disabled={disabled} />
      <SwitchRow label={t('rhinoExport.visibleOnlyLabel')} hint={t('rhinoExport.visibleOnlyHint')}
        checked={settings.visibleOnly} onChange={(visibleOnly) => onChange({ visibleOnly })} disabled={disabled} />
    </>
  );
}

/** Indeterminate for the scene build and the serialize step, a bar for objects. */
export function RhinoExportProgressRow({ progress, onStop }: { progress: RhinoExportProgress; onStop: () => void }) {
  const { t, locale } = useTranslation();
  const label = progress.phase === 'scene'
    ? t('rhinoExport.progress.scene')
    : progress.phase === 'serialize'
      ? t('rhinoExport.progress.serialize')
      : t('rhinoExport.progress.objects', { done: formatLocaleNumber(locale, progress.done), total: formatLocaleNumber(locale, progress.total) });
  return (
    <div className="space-y-2" data-rhino-export-progress={progress.phase}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <output className="flex items-center gap-2">
          <Spinner size="md" />
          {label}
        </output>
        <Button variant="outline" size="sm" onClick={onStop}>{t('rhinoExport.stopButton')}</Button>
      </div>
      {progress.phase === 'objects' && (
        <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
      )}
    </div>
  );
}
