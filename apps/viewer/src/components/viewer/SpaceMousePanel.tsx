/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SpaceMouse settings (#1677, moved to Preferences by #5509): connect a
 * 3Dconnexion device over WebHID and tune its sensitivity. The connect
 * button must stay a plain click handler, WebHID only shows its device
 * chooser from a user gesture. Everything device-side lives in
 * useSpaceMouseControls; this is a thin view over the spaceMouse store
 * slice, rendered inside the Preferences dialog's Navigation section
 * (`KeyboardShortcutsDialog.tsx`) rather than floated over the viewport.
 */

import { useEffect, useId, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Copy, Unplug } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AXIS_FULL_SCALE, SENSITIVITY } from '@/lib/spacemouse/constants';
import type { SpaceMouseDiagnostics } from '@/lib/spacemouse/device';

const AXIS_KEYS = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const;

/** One centered axis bar: fill grows left or right of the midline. */
function AxisBar({ label, value }: { label: string; value: number }) {
  const fraction = Math.max(-1, Math.min(1, value / AXIS_FULL_SCALE));
  const half = Math.abs(fraction) * 50;
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-4 shrink-0 font-mono text-2xs uppercase text-muted-foreground">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/30" />
        <div
          className={cn('absolute inset-y-0 bg-primary', fraction === 0 && 'opacity-0')}
          style={fraction >= 0
            ? { left: '50%', width: `${half}%` }
            : { right: '50%', width: `${half}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
        {Math.round(value)}
      </span>
    </div>
  );
}

export function SpaceMousePanel() {
  const sensitivityId = useId();
  const { t } = useTranslation();

  const supported = useViewerStore((s) => s.spaceMouseSupported);
  const connected = useViewerStore((s) => s.spaceMouseConnected);
  const deviceName = useViewerStore((s) => s.spaceMouseDeviceName);
  const error = useViewerStore((s) => s.spaceMouseError);
  const sensitivity = useViewerStore((s) => s.spaceMouseSensitivity);
  const setSensitivity = useViewerStore((s) => s.setSpaceMouseSensitivity);
  const connect = useViewerStore((s) => s.spaceMouseConnect);
  const disconnect = useViewerStore((s) => s.spaceMouseDisconnect);
  const getDiagnostics = useViewerStore((s) => s.spaceMouseGetDiagnostics);

  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState<SpaceMouseDiagnostics | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Poll the session's diagnostics snapshot at UI rate while the section is
  // visible. Reports stream at ~125Hz; pushing each one through the store
  // would be waste, so the panel pulls instead.
  const diagActive = diagOpen && !!getDiagnostics;
  useEffect(() => {
    if (!diagActive || !getDiagnostics) {
      setDiag(null);
      return;
    }
    setDiag(getDiagnostics());
    const timer = setInterval(() => setDiag(getDiagnostics()), 100);
    return () => clearInterval(timer);
  }, [diagActive, getDiagnostics]);

  const copyDump = async () => {
    const dump = getDiagnostics?.().buildDump();
    if (!dump) return;
    try {
      await navigator.clipboard.writeText(dump);
      setCopyState('copied');
    } catch {
      setCopyState('failed'); // clipboard blocked (permissions / unfocused doc)
    }
    setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <div className="flex flex-col gap-2 text-xs">
      {!supported ? (
        <p className="text-2xs leading-snug text-muted-foreground">
          {t('spaceMousePanel.noWebHidMessage')}
        </p>
      ) : connected ? (
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-foreground" title={deviceName ?? undefined}>
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-status-ok align-middle" />
            {deviceName ?? t('spaceMousePanel.deviceNameFallback')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => disconnect?.()}
            title={t('spaceMousePanel.disconnectTitle')}
            className="h-7 gap-1 px-2 text-2xs text-muted-foreground"
          >
            <Unplug className="h-3 w-3" />
            {t('spaceMousePanel.disconnectButton')}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          onClick={() => connect?.()}
          disabled={!connect}
          className="w-full"
        >
          {t('spaceMousePanel.connectButton')}
        </Button>
      )}

      {error && !connected && (
        <p className="text-2xs leading-snug text-destructive">{error}</p>
      )}

      {supported && (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="flex justify-between text-2xs uppercase tracking-wider text-muted-foreground">
              <label htmlFor={sensitivityId}>{t('spaceMousePanel.sensitivityLabel')}</label>
              <button
                type="button"
                onClick={() => setSensitivity(SENSITIVITY.default)}
                title={t('spaceMousePanel.resetSensitivityTitle')}
                className={cn(
                  'tabular-nums transition-colors',
                  sensitivity !== SENSITIVITY.default && 'text-foreground hover:text-primary',
                )}
              >
                {t('spaceMousePanel.sensitivityValue', { value: sensitivity.toFixed(1) })}
              </button>
            </span>
            <input
              id={sensitivityId}
              type="range"
              min={SENSITIVITY.min}
              max={SENSITIVITY.max}
              step={SENSITIVITY.step}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>

          <p className="text-2xs leading-snug text-muted-foreground">
            {t('spaceMousePanel.guidanceMessage')}
          </p>

          {connected && getDiagnostics && (
            <div className="flex flex-col gap-1.5 border-t pt-1.5">
              <button
                type="button"
                onClick={() => setDiagOpen(!diagOpen)}
                aria-expanded={diagOpen}
                className="flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                <Activity className="h-3 w-3" />
                {t('spaceMousePanel.diagnosticsLabel')}
                {diagOpen ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
              </button>

              {diagOpen && diag && (
                <>
                  <div className="flex flex-col gap-0.5">
                    {AXIS_KEYS.map((axis) => (
                      <AxisBar key={axis} label={axis} value={diag.axes[axis]} />
                    ))}
                  </div>

                  <div className="font-mono text-2xs leading-snug text-muted-foreground">
                    <div>
                      {t('spaceMousePanel.layoutLine', {
                        value: diag.layoutSource === 'descriptor'
                          ? t('spaceMousePanel.layoutDescriptor', { axes: diag.layoutAxes })
                          : t('spaceMousePanel.layoutBuiltIn'),
                      })}
                    </div>
                    {diag.reports.length === 0 ? (
                      <div>{t('spaceMousePanel.noReportsMessage')}</div>
                    ) : (
                      diag.reports.map((r) => (
                        <div key={r.reportId} className="truncate" title={r.lastBytesHex}>
                          {t('spaceMousePanel.reportLine', {
                            id: r.reportId,
                            count: r.count,
                            bytes: r.byteLength,
                            hex: r.lastBytesHex,
                          })}
                        </div>
                      ))
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => { void copyDump(); }}
                    className="h-7 gap-1 text-2xs text-muted-foreground"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    {copyState === 'copied'
                      ? t('spaceMousePanel.copiedLabel')
                      : copyState === 'failed'
                        ? t('spaceMousePanel.copyFailedLabel')
                        : t('spaceMousePanel.copyDeviceReportLabel')}
                  </Button>
                  <p className="text-2xs leading-snug text-muted-foreground">
                    {t('spaceMousePanel.reportHintMessage')}
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
