/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useTranslation, type TranslationKey } from '@/i18n';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import { roofEdgeSlopes, withRoofPitch, type RoofPreset } from '@/lib/commands/modeling/commands/roof-place-params';
import { type SlabPlaceGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import { HudDivider, HudSegmented, HudValueField } from '../../../viewport-ui/hud';
const KEYS: Record<RoofPreset, TranslationKey> = {
  hip: 'modelingCommand.roof.hip', gable: 'modelingCommand.roof.gable',
  mono: 'modelingCommand.roof.mono', flat: 'modelingCommand.roof.flat',
};
const LABEL_CLASS = 'text-2xs text-overlay-ink-muted';
export function RoofPlaceBar({ gesture }: { gesture: SlabPlaceGesture }) {
  const { t } = useTranslation();
  const roof = gesture.roof;
  const pitchLabel = t('modelingCommand.roof.pitch');
  const overhangLabel = t('modelingCommand.roof.overhang');
  const edgeLabel = t('modelingCommand.roof.edge');
  const slopeLabel = t('modelingCommand.roof.edgeSlope');
  const outline = gesture.mode === 'rectangle'
    ? [[0, 0], [10, 0], [10, 8], [0, 8]] as const
    : gesture.points;
  const count = Math.max(1, outline.length);
  const edge = Math.min(roof.edge, count - 1);
  // Before a polygon closes, its preset may have no opposite edge yet.
  let slope = roof.overrides[edge] ?? 0;
  if (outline.length >= 3) {
    try { slope = roofEdgeSlopes(roof, outline)[edge] * 180 / Math.PI; }
    catch (error) { console.debug('[roof HUD] footprint not ready', error); }
  }
  const update = (patch: Partial<typeof roof>) => updateCommandGesture((value) => { const g = value as SlabPlaceGesture; return { ...g, roof: { ...g.roof, ...patch } }; });
  return <>
    <HudDivider />
    <HudSegmented aria-label={t('modelingCommand.roof.shape')}
      options={(Object.keys(KEYS) as RoofPreset[]).map(value => ({ value, label: t(KEYS[value]) }))}
      value={roof.preset} onChange={(preset) => update({ preset, overrides: {} })} />
    <HudDivider />
    <span className={LABEL_CLASS}>{pitchLabel}</span>
    <HudValueField aria-label={pitchLabel} value={roof.pitch} unit="°" min={0} max={85} precision={1}
      onChange={(value) => update(withRoofPitch(roof, value))} />
    <span className={LABEL_CLASS}>{overhangLabel}</span>
    <HudValueField aria-label={overhangLabel} value={roof.overhang} unit="m" min={0} step={0.1}
      onChange={(value) => update({ overhang: Math.max(0, value) })} />
    <HudDivider />
    <span className={LABEL_CLASS}>{edgeLabel}</span>
    <HudValueField aria-label={edgeLabel} value={edge + 1} precision={0} min={1} max={count}
      onChange={(value) => update({ edge: Math.max(0, Math.min(count - 1, Math.round(value) - 1)) })} />
    <span className={LABEL_CLASS}>{slopeLabel}</span>
    <HudValueField aria-label={slopeLabel} value={slope} unit="°" min={0} max={85} precision={1}
      onChange={(value) => update({ overrides: { ...roof.overrides, [edge]: Math.max(0, Math.min(85, value)) } })} />
  </>;
}
