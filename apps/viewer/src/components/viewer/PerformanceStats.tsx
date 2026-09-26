/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Diagnostic readouts mount only when the user enables performance stats. */

import { useEffect, useMemo, useState } from 'react';
import { Triangle } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { useTranslation } from '@/i18n';
import { formatBytes, formatNumber } from '@/lib/utils';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store';

export function TriangleCount({ models, geometryResult }: {
  models: Map<string, FederatedModel>;
  geometryResult: GeometryResult | null;
}) {
  const { t } = useTranslation();
  const count = useMemo(() => {
    if (models.size === 0) return geometryResult?.totalTriangles ?? 0;
    let total = 0;
    for (const model of models.values()) total += model.geometryResult?.totalTriangles ?? 0;
    return total;
  }, [models, geometryResult]);

  return (
    <div className="flex items-center gap-1.5">
      <Triangle className="h-3.5 w-3.5" />
      <span>{formatNumber(count)} {t('shellChrome.statusBar.trisCount', { count })}</span>
    </div>
  );
}

export function FpsMemoryStats() {
  const { t } = useTranslation();
  const [fps, setFps] = useState(60);
  const [memory, setMemory] = useState(0);

  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let animationId: number;
    const measureFps = () => {
      frameCount++;
      const currentTime = performance.now();
      if (currentTime - lastTime >= 1000) {
        setFps(frameCount);
        frameCount = 0;
        lastTime = currentTime;
      }
      animationId = requestAnimationFrame(measureFps);
    };
    animationId = requestAnimationFrame(measureFps);
    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    const updateMemory = () => {
      // Chromium-only; absent from lib.dom and other browsers.
      type PerformanceWithMemory = Performance & { memory?: { usedJSHeapSize: number } };
      const bytes = (performance as PerformanceWithMemory).memory?.usedJSHeapSize;
      if (bytes !== undefined) setMemory(bytes);
    };
    updateMemory();
    const interval = setInterval(updateMemory, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <span className={fps < 30 ? 'text-destructive' : fps < 50 ? 'text-yellow-500' : ''}>
        {fps} {t('shellChrome.statusBar.fpsUnit')}
      </span>
      {memory > 0 && (
        <>
          <Separator orientation="vertical" className="h-3.5" />
          <span>{formatBytes(memory)}</span>
        </>
      )}
    </>
  );
}
