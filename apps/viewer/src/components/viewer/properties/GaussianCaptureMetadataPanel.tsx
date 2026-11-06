/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Metadata for a Gaussian capture model (#8565/#8566). A capture has no IFC
 * schema, entities or storeys, so none of the IFC panel's claims apply: this
 * shows what the loader actually knows, and its limitations, instead.
 */

import { useState, type ReactNode } from 'react';
import { Clock, HardDrive, Info, Move3D, Ruler, RotateCw, ScanLine, ShieldAlert, Sparkles } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { FederatedModel } from '@/store/types';
import type { GaussianSplatModel } from '@/hooks/ingest/gaussianIngest';
import { appliedGaussianUpAxis } from '@/hooks/ingest/gaussianCaptureFrame';
import { gaussianNeedsReload, setGaussianCaptureUpAxis, useGaussianCaptureState } from '@/hooks/ingest/gaussianAssets';
import { useGaussianReload } from '@/hooks/ingest/gaussianReload';
import { toast } from '@/components/ui/toast';
import { gaussianStateLabel } from '../gaussian-capture-state';
import { useTranslation } from '@/i18n';
import { formatLocaleDate, formatLocaleNumber } from '@/i18n/intlFormat';

/** The disclosed launch limitations (#8568), in the order the user guide lists them. */
const GAUSSIAN_CAPTURE_LIMITATIONS = ['composition', 'clipping', 'uncalibrated', 'picking', 'measurement', 'export'] as const;

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {icon}
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono text-foreground ml-auto text-right">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border">
      <div className="p-3 bg-muted">
        <h4 className="font-bold text-xs uppercase tracking-wide text-muted-foreground">{title}</h4>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

export function GaussianCaptureMetadataPanel({ model, capture }: { model: FederatedModel; capture: GaussianSplatModel }) {
  const { t, locale } = useTranslation();
  const icon = (Icon: typeof Info) => <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  const state = useGaussianCaptureState(model);
  const label = gaussianStateLabel(state);
  const reload = useGaussianReload();
  const [changingAxis, setChangingAxis] = useState(false);
  const fileSize = formatLocaleNumber(locale, model.fileSize / (1024 * 1024), { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
  return (
    <div className="h-full flex flex-col border-l-2 border-border bg-white dark:bg-black" data-testid="gaussian-capture-metadata">
      <div className="p-4 border-b-2 border-border bg-muted dark:bg-black space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 border-2 border-primary/30 bg-primary/10 shrink-0">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="font-bold text-sm truncate uppercase tracking-tight text-foreground">{model.name}</h3>
            <p className="text-xs font-mono text-muted-foreground">{t('gaussianCapture.kind')}</p>
          </div>
        </div>
        <span className="text-2xs font-mono bg-primary/10 border border-primary/30 px-2 py-1 text-primary font-bold uppercase">
          {t(capture.format === 'splat' ? 'gaussianCapture.format.splat' : 'gaussianCapture.format.gaussianPly')}
        </span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <Section title={t('gaussianCapture.heading.capture')}>
          <Row icon={icon(HardDrive)} label={t('properties.modelMetadata.fileSize')}>{fileSize}</Row>
          <Row icon={icon(Clock)} label={t('properties.modelMetadata.loadedAt')}>{formatLocaleDate(locale, new Date(model.loadedAt), { dateStyle: 'short', timeStyle: 'medium' })}</Row>
          <Row icon={icon(Sparkles)} label={t('gaussianCapture.splats')}>{formatLocaleNumber(locale, capture.count)}</Row>
          <Row icon={icon(Info)} label={t('gaussianCapture.shDegree')}>{capture.shDegree}</Row>
          <Row icon={icon(Move3D)} label={t('gaussianCapture.placement')}>
            {t(capture.placementOrigin === 'explicit' ? 'gaussianCapture.placement.explicit' : 'gaussianCapture.placement.source')}
          </Row>
          <div className="px-3 py-2 flex items-center justify-between gap-3">
            <label className="text-xs text-muted-foreground" htmlFor={`capture-up-axis-${model.id}`}>{t('gaussianCapture.upAxis')}</label>
            <select id={`capture-up-axis-${model.id}`} className="text-xs bg-transparent border border-border"
              value={appliedGaussianUpAxis(capture.placementOrigin === 'explicit' ? capture.sourcePlacement ?? capture.placement : undefined, capture.upAxis)} disabled={changingAxis || state.state !== 'resident'}
              onChange={(event) => {
                const axis = event.target.value;
                if (axis !== 'z' && axis !== 'y') return;
                setChangingAxis(true);
                void setGaussianCaptureUpAxis(model.id, axis).then((ok) => {
                  if (!ok) toast.error(t('gaussianCapture.upAxis.failed'));
                }).catch(() => toast.error(t('gaussianCapture.upAxis.failed'))).finally(() => setChangingAxis(false));
              }}>
              <option value="z">{t('gaussianCapture.upAxis.z')}</option>
              <option value="y">{t('gaussianCapture.upAxis.y')}</option>
            </select>
          </div>
          <Row icon={icon(ShieldAlert)} label={t('gaussianCapture.calibration')}>{t('gaussianCapture.calibration.uncalibrated')}</Row>
          <Row icon={icon(Ruler)} label={t('gaussianCapture.scale')}>{t('gaussianCapture.scale.unknown')}</Row>
          <Row icon={icon(ScanLine)} label={t('gaussianCapture.rendererState')}>
            <output data-testid="gaussian-capture-state">{t(label.key, label.values)}</output>
          </Row>
          {gaussianNeedsReload(state) && (
            <div className="px-3 py-2">
              <button type="button" className="inline-flex items-center gap-1 border border-border px-2 py-1 text-xs"
                onClick={() => void reload(model.id).then((result) => {
                  if (!result.ok) toast.error(t(result.reason === 'source-unavailable' ? 'gaussianCapture.reload.sourceUnavailable' : 'gaussianCapture.reload.notLoaded'));
                })}>
                <RotateCw className="h-3.5 w-3.5" aria-hidden />{t('gaussianCapture.row.reload')}
              </button>
            </div>
          )}
          {capture.attribution && <Row icon={icon(Info)} label={t('gaussianCapture.attribution')}>{capture.attribution}</Row>}
        </Section>
        <Section title={t('gaussianCapture.heading.limitations')}>
          {GAUSSIAN_CAPTURE_LIMITATIONS.map((limit) => (
            <p key={limit} data-limitation={limit} className="px-3 py-2 text-xs text-muted-foreground">{t(`gaussianCapture.limitation.${limit}`)}</p>
          ))}
        </Section>
      </ScrollArea>
    </div>
  );
}
