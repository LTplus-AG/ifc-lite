/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SpaceMouse panel (#1677): connect a 3Dconnexion device over WebHID and tune
 * its sensitivity. The connect button must stay a plain click handler, WebHID
 * only shows its device chooser from a user gesture. Everything device-side
 * lives in useSpaceMouseControls; this panel is a thin view over the
 * spaceMouse store slice.
 */

import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Copy, GripVertical, Unplug } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useDraggablePanel } from '@/hooks/useDraggablePanel';
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
      <span className="w-4 shrink-0 font-mono text-[9px] uppercase text-muted-foreground">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/30" />
        <div
          className={cn('absolute inset-y-0 bg-teal-500', fraction === 0 && 'opacity-0')}
          style={fraction >= 0
            ? { left: '50%', width: `${half}%` }
            : { right: '50%', width: `${half}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-[9px] tabular-nums text-muted-foreground">
        {Math.round(value)}
      </span>
    </div>
  );
}

export function SpaceMousePanel() {
  const open = useViewerStore((s) => s.spaceMousePanelOpen);

  const supported = useViewerStore((s) => s.spaceMouseSupported);
  const connected = useViewerStore((s) => s.spaceMouseConnected);
  const deviceName = useViewerStore((s) => s.spaceMouseDeviceName);
  const error = useViewerStore((s) => s.spaceMouseError);
  const sensitivity = useViewerStore((s) => s.spaceMouseSensitivity);
  const setSensitivity = useViewerStore((s) => s.setSpaceMouseSensitivity);
  const connect = useViewerStore((s) => s.spaceMouseConnect);
  const disconnect = useViewerStore((s) => s.spaceMouseDisconnect);
  const getDiagnostics = useViewerStore((s) => s.spaceMouseGetDiagnostics);

  const [collapsed, setCollapsed] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState<SpaceMouseDiagnostics | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Hooks must run unconditionally — keep these ABOVE the `!open` early return
  // (a conditional hook is React error #310).
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDraggablePanel(panelRef);

  // Poll the session's diagnostics snapshot at UI rate while the section is
  // visible. Reports stream at ~125Hz; pushing each one through the store
  // would be waste, so the panel pulls instead.
  const diagActive = open && !collapsed && diagOpen && !!getDiagnostics;
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

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      style={drag.style}
      className="pointer-events-auto absolute top-56 right-4 z-10 w-60 bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-2 text-xs"
    >
      {/* Header: the grip drags; the rest toggles collapse (same split of
          affordances as SunSkyPanel). */}
      <div className="flex items-center gap-1.5">
        <span
          onMouseDown={drag.onDragStart}
          title="Drag to move"
          className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="flex-1 flex items-center justify-between gap-2 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            SpaceMouse
          </span>
          <span className="text-muted-foreground">
            {collapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </span>
        </button>
      </div>

      {!collapsed && (
        <>
          {!supported ? (
            <p className="text-[9px] leading-snug text-muted-foreground">
              This browser has no WebHID support. Use a Chromium-based browser
              (Chrome or Edge) to navigate with a 3D mouse.
            </p>
          ) : connected ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[10px] text-foreground" title={deviceName ?? undefined}>
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-teal-500 align-middle" />
                {deviceName ?? 'SpaceMouse'}
              </span>
              <button
                type="button"
                onClick={() => disconnect?.()}
                title="Disconnect the device"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Unplug className="h-3 w-3" />
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => connect?.()}
              disabled={!connect}
              className="w-full rounded bg-teal-600 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white transition-colors hover:bg-teal-500 disabled:opacity-50"
            >
              Connect SpaceMouse
            </button>
          )}

          {error && !connected && (
            <p className="text-[9px] leading-snug text-amber-600 dark:text-amber-500">{error}</p>
          )}

          {supported && (
            <>
              <label className="flex flex-col gap-0.5">
                <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                  <span>Sensitivity</span>
                  <button
                    type="button"
                    onClick={() => setSensitivity(SENSITIVITY.default)}
                    title="Reset sensitivity"
                    className={cn(
                      'tabular-nums transition-colors',
                      sensitivity !== SENSITIVITY.default && 'text-foreground hover:text-teal-600',
                    )}
                  >
                    {sensitivity.toFixed(1)}x
                  </button>
                </span>
                <input
                  type="range"
                  min={SENSITIVITY.min}
                  max={SENSITIVITY.max}
                  step={SENSITIVITY.step}
                  value={sensitivity}
                  onChange={(e) => setSensitivity(Number(e.target.value))}
                  className="w-full accent-teal-600"
                />
              </label>

              <p className="text-[9px] leading-snug text-muted-foreground">
                Slide the cap to pan, push or pull it to zoom, twist and tilt
                to orbit. The device buttons fit the view. If the 3Dconnexion
                driver is running it may hold the device; quit it before
                connecting here.
              </p>

              {connected && getDiagnostics && (
                <div className="flex flex-col gap-1.5 border-t pt-1.5">
                  <button
                    type="button"
                    onClick={() => setDiagOpen(!diagOpen)}
                    aria-expanded={diagOpen}
                    className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Activity className="h-3 w-3" />
                    Diagnostics
                    {diagOpen ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
                  </button>

                  {diagOpen && diag && (
                    <>
                      <div className="flex flex-col gap-0.5">
                        {AXIS_KEYS.map((axis) => (
                          <AxisBar key={axis} label={axis} value={diag.axes[axis]} />
                        ))}
                      </div>

                      <div className="font-mono text-[8px] leading-snug text-muted-foreground">
                        <div>
                          layout: {diag.layoutSource === 'descriptor'
                            ? `descriptor (${diag.layoutAxes} axes)`
                            : 'built-in fallback'}
                        </div>
                        {diag.reports.length === 0 ? (
                          <div>no reports received yet, move the cap</div>
                        ) : (
                          diag.reports.map((r) => (
                            <div key={r.reportId} className="truncate" title={r.lastBytesHex}>
                              report {r.reportId}: {r.count}x {r.byteLength}B [{r.lastBytesHex}]
                            </div>
                          ))
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => { void copyDump(); }}
                        className="flex items-center justify-center gap-1 rounded border px-1.5 py-1 text-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Copy className="h-2.5 w-2.5" />
                        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed, try again' : 'Copy device report'}
                      </button>
                      <p className="text-[8px] leading-snug text-muted-foreground">
                        If motion is wrong or dead for your device, copy this
                        report and paste it into a GitHub issue so the axis
                        layout can be fixed for your model.
                      </p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
