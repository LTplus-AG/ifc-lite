/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, useEffect } from 'react';
import { Boxes, Triangle, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { formatNumber, formatBytes } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';

export function StatusBar() {
  const { loading, geometryResult, ifcDataStore } = useIfc();
  const progress = useViewerStore((s) => s.progress);
  const error = useViewerStore((s) => s.error);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const activeStreamCanceller = useViewerStore((s) => s.activeStreamCanceller);
  const webgpu = useWebGPU();

  const [fps, setFps] = useState(60);
  const [memory, setMemory] = useState(0);

  // FPS counter (simplified)
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

  // Memory usage (if available)
  useEffect(() => {
    const updateMemory = () => {
      if ((performance as any).memory) {
        setMemory((performance as any).memory.usedJSHeapSize);
      }
    };

    updateMemory();
    const interval = setInterval(updateMemory, 2000);
    return () => clearInterval(interval);
  }, []);

  const stats = useMemo(() => {
    if (!geometryResult) {
      return { elements: 0, triangles: 0 };
    }
    // Count actual entities: for color-merged meshes, count unique entity IDs
    let elements = 0;
    const meshes = geometryResult.meshes;
    if (meshes) {
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i] as { entityIds?: Uint32Array };
        if (m.entityIds && m.entityIds.length > 0) {
          // Count unique entity IDs in this merged mesh
          const seen = new Set<number>();
          for (let j = 0; j < m.entityIds.length; j++) seen.add(m.entityIds[j]);
          elements += seen.size;
        } else {
          elements += 1;
        }
      }
    }
    return {
      elements,
      triangles: geometryResult.totalTriangles ?? 0,
    };
  }, [geometryResult]);

  const visibleElements = useMemo(() => {
    if (selectedStoreys.size === 0 || !ifcDataStore?.spatialHierarchy) {
      return stats.elements;
    }
    // Count elements from all selected storeys
    let count = 0;
    for (const storeyId of selectedStoreys) {
      const storeyElements = ifcDataStore.spatialHierarchy.byStorey.get(storeyId);
      if (storeyElements) {
        count += storeyElements.length;
      }
    }
    return count || stats.elements;
  }, [selectedStoreys, ifcDataStore, stats.elements]);

  return (
    <div className="h-7 px-3 border-t bg-muted/30 flex items-center justify-between text-xs text-muted-foreground">
      {/* Left: Status */}
      <div className="flex items-center gap-3">
        {loading ? (
          <span className="text-primary">{progress?.phase || 'Loading...'}</span>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span>Ready</span>
        )}
        {/* Cancel button — only visible while a long-running stream
            (LAS/LAZ/PLY/PCD/E57) is in flight. The loader hooks
            register/clear the canceller around `await ingest.done`. */}
        {activeStreamCanceller && (
          <button
            type="button"
            onClick={() => activeStreamCanceller()}
            className="px-2 py-0.5 rounded border border-destructive/40 text-destructive text-[10px] uppercase tracking-wider hover:bg-destructive hover:text-destructive-foreground transition-colors"
            title="Cancel the active point cloud stream"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Center: Model Stats */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Boxes className="h-3.5 w-3.5" />
          <span>
            {formatNumber(visibleElements)}
            {selectedStoreys.size > 0 && stats.elements !== visibleElements && (
              <span className="opacity-60"> / {formatNumber(stats.elements)}</span>
            )}
            {' '}elements
          </span>
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        <div className="flex items-center gap-1.5">
          <Triangle className="h-3.5 w-3.5" />
          <span>{formatNumber(stats.triangles)} tris</span>
        </div>
      </div>

      {/* Right: Performance */}
      <div className="flex items-center gap-3">
        <span className={fps < 30 ? 'text-destructive' : fps < 50 ? 'text-yellow-500' : ''}>
          {fps} FPS
        </span>

        {memory > 0 && (
          <>
            <Separator orientation="vertical" className="h-3.5" />
            <span>{formatBytes(memory)}</span>
          </>
        )}

        <Separator orientation="vertical" className="h-3.5" />

        <div className="flex items-center gap-1">
          {webgpu.checking ? (
            <Loader2 className="h-3.5 w-3.5 text-zinc-400 animate-spin" />
          ) : webgpu.supported ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-[#f7768e]" />
          )}
          <span className={!webgpu.supported && !webgpu.checking ? 'text-[#f7768e]' : ''}>
            {webgpu.checking ? 'Checking...' : webgpu.supported ? 'WebGPU' : 'No WebGPU'}
          </span>
        </div>

        <Separator orientation="vertical" className="h-3.5" />

        <span className="opacity-60">v{__APP_VERSION__}</span>

        <Separator orientation="vertical" className="h-3.5" />

        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-60 hover:opacity-100 hover:text-primary transition-opacity"
          aria-label="Visit ifclite.dev — about, docs, and packages"
        >
          ifclite.dev →
        </a>
      </div>
    </div>
  );
}
