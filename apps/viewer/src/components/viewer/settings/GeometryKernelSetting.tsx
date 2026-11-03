/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → Performance: which geometry kernel the next load uses (#7955).
 * Saved per browser; `?kernel=` still overrides it for one tab. Mounted only
 * through the retained module, so it exists only in a retained-enabled build
 * (`VITE_RETAINED_GEOMETRY=on`, or `lazy`, which fetches it when Settings
 * opens). Deliberately not called "exact mode": that name belongs to the
 * fast/exact fidelity switch.
 */

import { useState } from 'react';
import { registerEnglish, useTranslation } from '@/i18n';
import { retainedGeometryEn } from '@/i18n/catalogues/retained-geometry.en';
import { crossOriginIsolatedPage, requestedGeometryKernel, saveGeometryKernel, type GeometryKernel } from '@/store/geometryKernel';
import { SettingsChoice, SettingsGroup, SettingsRow } from './SettingsGroup';

registerEnglish(retainedGeometryEn);

export function GeometryKernelSetting({ onChange }: { onChange?: (kernel: GeometryKernel) => void } = {}) {
  const { t } = useTranslation();
  const [kernel, setKernel] = useState<GeometryKernel>(() => requestedGeometryKernel());
  const available = crossOriginIsolatedPage(); // elsewhere a saved Retained is not applied either
  const options = [
    { value: 'exact' as const, label: t('retainedGeometry.setting.exact') },
    ...(available ? [{ value: 'retained' as const, label: t('retainedGeometry.setting.retained') }] : []),
  ];
  return (
    <SettingsGroup title={t('retainedGeometry.setting.title')}>
      <SettingsRow
        label={t('retainedGeometry.setting.title')}
        hint={t(available ? 'retainedGeometry.setting.hint' : 'retainedGeometry.setting.unavailable')}
      >
        <SettingsChoice<GeometryKernel>
          id="settings-geometry-kernel"
          label={t('retainedGeometry.setting.title')}
          value={available ? kernel : 'exact'}
          options={options}
          onChange={(next) => { saveGeometryKernel(next); setKernel(next); onChange?.(next); }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
