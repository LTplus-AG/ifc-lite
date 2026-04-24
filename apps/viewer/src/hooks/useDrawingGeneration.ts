/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useDrawingGeneration - Custom hook for 2D drawing generation logic
 *
 * Extracts the drawing generation pipeline from Section2DPanel, including:
 * - Section cut generation via Drawing2DGenerator
 * - Symbolic representation parsing and caching
 * - Hybrid drawing creation (symbolic + section cut)
 * - Bounding box alignment for symbolic lines
 * - Auto-generation effects (panel open, overlay enable, geometry change)
 * - Section plane change detection with overlap protection
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Drawing2DGenerator,
  createSectionConfig,
  type Drawing2D,
  type DrawingLine,
  type SectionConfig,
} from '@ifc-lite/drawing-2d';
import { GeometryProcessor, type GeometryResult } from '@ifc-lite/geometry';

// Axis conversion from semantic (down/front/side) to geometric (x/y/z)
export const AXIS_MAP: Record<'down' | 'front' | 'side', 'x' | 'y' | 'z'> = {
  down: 'y',
  front: 'z',
  side: 'x',
};

interface UseDrawingGenerationParams {
  geometryResult: GeometryResult | null | undefined;
  ifcDataStore: { source: Uint8Array } | null;
  sectionPlane: {
    axis: 'down' | 'front' | 'side';
    position: number;
    flipped: boolean;
    /** When set, the plane is an arbitrary world-space normal (face-pick). The
     * drawing pipeline currently only understands cardinal-axis cuts; the
     * generator short-circuits with an informative error in that case. */
    normal?: [number, number, number];
  };
  displayOptions: { showHiddenLines: boolean; useSymbolicRepresentations: boolean; show3DOverlay: boolean; scale: number };
  combinedHiddenIds: Set<number>;
  combinedIsolatedIds: Set<number> | null;
  computedIsolatedIds?: Set<number> | null;
  models: Map<string, { id: string; visible: boolean; idOffset?: number }>;
  panelVisible: boolean;
  drawing: Drawing2D | null;
  // Store actions
  setDrawing: (d: Drawing2D | null) => void;
  setDrawingStatus: (s: 'idle' | 'generating' | 'ready' | 'error') => void;
  setDrawingProgress: (p: number, phase: string) => void;
  setDrawingError: (e: string | null) => void;
}

interface UseDrawingGenerationResult {
  generateDrawing: (isRegenerate?: boolean) => Promise<void>;
  doRegenerate: () => Promise<void>;
  isRegenerating: boolean;
}

export function useDrawingGeneration({
  geometryResult,
  ifcDataStore,
  sectionPlane,
  displayOptions,
  combinedHiddenIds,
  combinedIsolatedIds,
  computedIsolatedIds,
  models,
  panelVisible,
  drawing,
  setDrawing,
  setDrawingStatus,
  setDrawingProgress,
  setDrawingError,
}: UseDrawingGenerationParams): UseDrawingGenerationResult {
  // Track if this is a regeneration (vs initial generation)
  const isRegeneratingRef = useRef(false);

  // Cache for symbolic representations - these don't change with section position
  // Only re-parse when model or display options change
  const symbolicCacheRef = useRef<{
    lines: DrawingLine[];
    entities: Set<number>;
    sourceId: string | null;
    useSymbolic: boolean;
  } | null>(null);

  // Generate drawing when panel opens
  const generateDrawing = useCallback(async (isRegenerate = false) => {
    if (!geometryResult?.meshes || geometryResult.meshes.length === 0) {
      // Clear the drawing when no geometry is available (e.g., all models hidden)
      setDrawing(null);
      setDrawingStatus('idle');
      setDrawingError('No visible geometry');
      return;
    }

    // Custom-normal planes (face-pick) bypass the 2D drawing pipeline until
    // the generator supports arbitrary plane normals. Without this guard the
    // generator would cut the model along the nearest cardinal axis and the
    // resulting drawing would not match the actual shader clip. Using
    // status='error' (not 'idle') so the Section2DPanel surfaces the reason
    // to the user instead of looking like "nothing happened".
    if (sectionPlane.normal !== undefined) {
      setDrawing(null);
      setDrawingStatus('error');
      setDrawingError('2D drawing is not available for custom face-picked planes. Switch to Down/Front/Side to generate.');
      return;
    }

    // Only show full loading overlay for initial generation, not regeneration
    if (!isRegenerate) {
      setDrawingStatus('generating');
      setDrawingProgress(0, 'Initializing...');
    }
    isRegeneratingRef.current = isRegenerate;

    // Parse symbolic representations if enabled (for hybrid mode)
    // OPTIMIZATION: Cache symbolic data - it doesn't change with section position
    let symbolicLines: DrawingLine[] = [];
    let entitiesWithSymbols = new Set<number>();

    // For multi-model: create cache key from model count and visible model IDs
    // For single-model: use source byteLength as before
    const modelCacheKey = models.size > 0
      ? `${models.size}-${[...models.values()].filter(m => m.visible).map(m => m.id).sort().join(',')}`
      : (ifcDataStore?.source ? String(ifcDataStore.source.byteLength) : null);

    const useSymbolic = displayOptions.useSymbolicRepresentations && !!ifcDataStore?.source;

    // Check if we can use cached symbolic data
    const cache = symbolicCacheRef.current;
    const cacheValid = cache &&
      cache.sourceId === modelCacheKey &&
      cache.useSymbolic === useSymbolic;

    if (useSymbolic) {
      if (cacheValid) {
        // Use cached data - FAST PATH
        symbolicLines = cache.lines;
        entitiesWithSymbols = cache.entities;
      } else {
        // Need to parse - only on first load or when model changes
        try {
          if (!isRegenerate) {
            setDrawingProgress(5, 'Parsing symbolic representations...');
          }

          const processor = new GeometryProcessor();
          try {
            await processor.init();

            const symbolicCollection = processor.parseSymbolicRepresentations(ifcDataStore!.source);
            // For single-model (legacy) mode, model index is always 0
            // Multi-model symbolic parsing would require iterating over each model separately
            const symbolicModelIndex = 0;

            if (symbolicCollection && !symbolicCollection.isEmpty) {
              // Process polylines
              for (let i = 0; i < symbolicCollection.polylineCount; i++) {
                const poly = symbolicCollection.getPolyline(i);
                if (!poly) continue;

                entitiesWithSymbols.add(poly.expressId);
                const points = poly.points;
                const pointCount = poly.pointCount;

                for (let j = 0; j < pointCount - 1; j++) {
                  symbolicLines.push({
                    line: {
                      start: { x: points[j * 2], y: points[j * 2 + 1] },
                      end: { x: points[(j + 1) * 2], y: points[(j + 1) * 2 + 1] }
                    },
                    category: 'silhouette',
                    visibility: 'visible',
                    entityId: poly.expressId,
                    ifcType: poly.ifcType,
                    modelIndex: symbolicModelIndex,
                    depth: 0,
                  });
                }

                if (poly.isClosed && pointCount > 2) {
                  symbolicLines.push({
                    line: {
                      start: { x: points[(pointCount - 1) * 2], y: points[(pointCount - 1) * 2 + 1] },
                      end: { x: points[0], y: points[1] }
                    },
                    category: 'silhouette',
                    visibility: 'visible',
                    entityId: poly.expressId,
                    ifcType: poly.ifcType,
                    modelIndex: symbolicModelIndex,
                    depth: 0,
                  });
                }
              }

              // Process circles/arcs
              for (let i = 0; i < symbolicCollection.circleCount; i++) {
                const circle = symbolicCollection.getCircle(i);
                if (!circle) continue;

                entitiesWithSymbols.add(circle.expressId);
                const numSegments = circle.isFullCircle ? 32 : 16;

                for (let j = 0; j < numSegments; j++) {
                  const t1 = j / numSegments;
                  const t2 = (j + 1) / numSegments;
                  const a1 = circle.startAngle + t1 * (circle.endAngle - circle.startAngle);
                  const a2 = circle.startAngle + t2 * (circle.endAngle - circle.startAngle);

                  symbolicLines.push({
                    line: {
                      start: {
                        x: circle.centerX + circle.radius * Math.cos(a1),
                        y: circle.centerY + circle.radius * Math.sin(a1),
                      },
                      end: {
                        x: circle.centerX + circle.radius * Math.cos(a2),
                        y: circle.centerY + circle.radius * Math.sin(a2),
                      },
                    },
                    category: 'silhouette',
                    visibility: 'visible',
                    entityId: circle.expressId,
                    ifcType: circle.ifcType,
                    modelIndex: symbolicModelIndex,
                    depth: 0,
                  });
                }
              }
            }
          } finally {
            processor.dispose();
          }

          // Cache the parsed data
          symbolicCacheRef.current = {
            lines: symbolicLines,
            entities: entitiesWithSymbols,
            sourceId: modelCacheKey,
            useSymbolic,
          };
        } catch (error) {
          console.warn('Symbolic parsing failed:', error);
          symbolicLines = [];
          entitiesWithSymbols = new Set<number>();
        }
      }
    } else {
      // Clear cache if symbolic is disabled
      if (cache && cache.useSymbolic) {
        symbolicCacheRef.current = null;
      }
    }

    let generator: Drawing2DGenerator | null = null;
    try {
      generator = new Drawing2DGenerator();
      await generator.initialize();

      // Convert semantic axis to geometric
      const axis = AXIS_MAP[sectionPlane.axis];

      // Calculate section position from percentage using coordinateInfo bounds
      const bounds = geometryResult.coordinateInfo.shiftedBounds;

      const axisMin = bounds.min[axis];
      const axisMax = bounds.max[axis];
      const position = axisMin + (sectionPlane.position / 100) * (axisMax - axisMin);

      // Calculate max depth as half the model extent
      const maxDepth = (axisMax - axisMin) * 0.5;

      // Adjust progress to account for symbolic parsing phase (0-20%)
      const progressOffset = symbolicLines.length > 0 ? 20 : 0;
      const progressScale = symbolicLines.length > 0 ? 0.8 : 1;
      const progressCallback = (stage: string, prog: number) => {
        setDrawingProgress(progressOffset + prog * 100 * progressScale, stage);
      };

      // Create section config
      const config: SectionConfig = createSectionConfig(axis, position, {
        projectionDepth: maxDepth,
        includeHiddenLines: displayOptions.showHiddenLines,
        scale: displayOptions.scale,
      });

      // Override the flipped setting
      config.plane.flipped = sectionPlane.flipped;

      // Filter meshes by visibility (respect 3D hiding/isolation)
      let meshesToProcess = geometryResult.meshes;

      // Filter out hidden entities (using combined multi-model set)
      if (combinedHiddenIds.size > 0) {
        meshesToProcess = meshesToProcess.filter(
          mesh => !combinedHiddenIds.has(mesh.expressId)
        );
      }

      // Filter by isolation (if active, using combined multi-model set)
      if (combinedIsolatedIds !== null) {
        meshesToProcess = meshesToProcess.filter(
          mesh => combinedIsolatedIds.has(mesh.expressId)
        );
      }

      // Also filter by computedIsolatedIds (storey selection)
      if (computedIsolatedIds !== null && computedIsolatedIds !== undefined && computedIsolatedIds.size > 0) {
        const isolatedSet = computedIsolatedIds;
        meshesToProcess = meshesToProcess.filter(
          mesh => isolatedSet.has(mesh.expressId)
        );
      }

      // If all meshes were filtered out by visibility, clear the drawing
      if (meshesToProcess.length === 0) {
        setDrawing(null);
        setDrawingStatus('idle');
        setDrawingError(null);
        return;
      }

      const result = await generator.generate(meshesToProcess, config, {
        includeHiddenLines: false,  // Disable - causes internal mesh edges
        includeProjection: false,   // Disable - causes triangulation lines
        includeEdges: false,        // Disable - causes triangulation lines
        mergeLines: true,
        onProgress: progressCallback,
      });

      // If we have symbolic representations, create a hybrid drawing
      if (symbolicLines.length > 0 && entitiesWithSymbols.size > 0) {
        // Get entity IDs that actually appear in the section cut (these are being cut by the plane)
        const cutEntityIds = new Set<number>();
        for (const line of result.lines) {
          if (line.entityId !== undefined) {
            cutEntityIds.add(line.entityId);
          }
        }
        // Also check cut polygons for entity IDs
        for (const poly of result.cutPolygons ?? []) {
          if ((poly as { entityId?: number }).entityId !== undefined) {
            cutEntityIds.add((poly as { entityId?: number }).entityId!);
          }
        }

        // Only include symbolic lines for entities that are ACTUALLY being cut
        // This filters out symbols from other floors/levels not intersected by the section plane
        const relevantSymbolicLines = symbolicLines.filter(line =>
          line.entityId !== undefined && cutEntityIds.has(line.entityId)
        );

        // Get the set of entities that have both symbols AND are being cut
        const entitiesWithRelevantSymbols = new Set<number>();
        for (const line of relevantSymbolicLines) {
          if (line.entityId !== undefined) {
            entitiesWithRelevantSymbols.add(line.entityId);
          }
        }

        // Align symbolic geometry with section cut geometry using bounding box matching
        // Plan representations often have different local origins than Body representations
        // So we compute per-entity transforms to align Plan bbox center with section cut bbox center

        // Build per-entity bounding boxes for section cut
        const sectionCutBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
        const updateBounds = (entityId: number, x: number, y: number) => {
          const bounds = sectionCutBounds.get(entityId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          bounds.minX = Math.min(bounds.minX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.maxY = Math.max(bounds.maxY, y);
          sectionCutBounds.set(entityId, bounds);
        };
        for (const line of result.lines) {
          if (line.entityId === undefined) continue;
          updateBounds(line.entityId, line.line.start.x, line.line.start.y);
          updateBounds(line.entityId, line.line.end.x, line.line.end.y);
        }
        // Include cut polygon vertices in bounds computation
        for (const poly of result.cutPolygons ?? []) {
          const entityId = (poly as { entityId?: number }).entityId;
          if (entityId === undefined) continue;
          for (const pt of poly.polygon.outer) {
            updateBounds(entityId, pt.x, pt.y);
          }
          for (const hole of poly.polygon.holes) {
            for (const pt of hole) {
              updateBounds(entityId, pt.x, pt.y);
            }
          }
        }

        // Build per-entity bounding boxes for symbolic
        const symbolicBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
        for (const line of relevantSymbolicLines) {
          if (line.entityId === undefined) continue;
          const bounds = symbolicBounds.get(line.entityId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          bounds.minX = Math.min(bounds.minX, line.line.start.x, line.line.end.x);
          bounds.minY = Math.min(bounds.minY, line.line.start.y, line.line.end.y);
          bounds.maxX = Math.max(bounds.maxX, line.line.start.x, line.line.end.x);
          bounds.maxY = Math.max(bounds.maxY, line.line.start.y, line.line.end.y);
          symbolicBounds.set(line.entityId, bounds);
        }

        // Compute per-entity alignment transforms (center-to-center offset)
        const alignmentOffsets = new Map<number, { dx: number; dy: number }>();
        for (const entityId of entitiesWithRelevantSymbols) {
          const scBounds = sectionCutBounds.get(entityId);
          const symBounds = symbolicBounds.get(entityId);
          if (scBounds && symBounds) {
            const scCenterX = (scBounds.minX + scBounds.maxX) / 2;
            const scCenterY = (scBounds.minY + scBounds.maxY) / 2;
            const symCenterX = (symBounds.minX + symBounds.maxX) / 2;
            const symCenterY = (symBounds.minY + symBounds.maxY) / 2;
            alignmentOffsets.set(entityId, {
              dx: scCenterX - symCenterX,
              dy: scCenterY - symCenterY,
            });
          }
        }

        // Apply alignment offsets to symbolic lines
        const alignedSymbolicLines = relevantSymbolicLines.map(line => {
          const offset = line.entityId !== undefined ? alignmentOffsets.get(line.entityId) : undefined;
          if (offset) {
            return {
              ...line,
              line: {
                start: { x: line.line.start.x + offset.dx, y: line.line.start.y + offset.dy },
                end: { x: line.line.end.x + offset.dx, y: line.line.end.y + offset.dy },
              },
            };
          }
          return line;
        });

        // Filter out section cut lines for entities that have relevant symbolic representations
        const filteredLines = result.lines.filter((line: DrawingLine) =>
          line.entityId === undefined || !entitiesWithRelevantSymbols.has(line.entityId)
        );

        // Also filter cut polygons for entities with relevant symbols
        const filteredCutPolygons = result.cutPolygons?.filter((poly: { entityId?: number }) =>
          poly.entityId === undefined || !entitiesWithRelevantSymbols.has(poly.entityId)
        ) ?? [];

        // Combine filtered section cuts with aligned symbolic lines
        const combinedLines = [...filteredLines, ...alignedSymbolicLines];

        // Recalculate bounds with combined lines and polygons
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const line of combinedLines) {
          minX = Math.min(minX, line.line.start.x, line.line.end.x);
          minY = Math.min(minY, line.line.start.y, line.line.end.y);
          maxX = Math.max(maxX, line.line.start.x, line.line.end.x);
          maxY = Math.max(maxY, line.line.start.y, line.line.end.y);
        }
        // Include polygon vertices in bounds
        for (const poly of filteredCutPolygons) {
          for (const pt of poly.polygon.outer) {
            minX = Math.min(minX, pt.x);
            minY = Math.min(minY, pt.y);
            maxX = Math.max(maxX, pt.x);
            maxY = Math.max(maxY, pt.y);
          }
          for (const hole of poly.polygon.holes) {
            for (const pt of hole) {
              minX = Math.min(minX, pt.x);
              minY = Math.min(minY, pt.y);
              maxX = Math.max(maxX, pt.x);
              maxY = Math.max(maxY, pt.y);
            }
          }
        }

        // Create hybrid drawing
        const hybridDrawing: Drawing2D = {
          ...result,
          lines: combinedLines,
          cutPolygons: filteredCutPolygons,
          bounds: {
            min: { x: isFinite(minX) ? minX : result.bounds.min.x, y: isFinite(minY) ? minY : result.bounds.min.y },
            max: { x: isFinite(maxX) ? maxX : result.bounds.max.x, y: isFinite(maxY) ? maxY : result.bounds.max.y },
          },
          stats: {
            ...result.stats,
            cutLineCount: combinedLines.length,
          },
        };

        setDrawing(hybridDrawing);
      } else {
        setDrawing(result);
      }

      // Always set status to ready (whether initial generation or regeneration)
      setDrawingStatus('ready');
      isRegeneratingRef.current = false;
    } catch (error) {
      console.error('Drawing generation failed:', error);
      setDrawingError(error instanceof Error ? error.message : 'Generation failed');
    } finally {
      // Always cleanup generator to prevent resource leaks
      generator?.dispose();
    }
  }, [
    geometryResult,
    ifcDataStore,
    sectionPlane,
    displayOptions,
    combinedHiddenIds,
    combinedIsolatedIds,
    computedIsolatedIds,
    models,
    setDrawing,
    setDrawingStatus,
    setDrawingProgress,
    setDrawingError,
  ]);

  // Track panel visibility and geometry for detecting changes
  const prevPanelVisibleRef = useRef(false);
  const prevOverlayEnabledRef = useRef(false);
  const prevMeshCountRef = useRef(0);

  // Auto-generate when panel opens (or 3D overlay is enabled) and no drawing exists
  // Also regenerate when geometry changes significantly (e.g., models hidden/shown)
  useEffect(() => {
    const wasVisible = prevPanelVisibleRef.current;
    const wasOverlayEnabled = prevOverlayEnabledRef.current;
    const prevMeshCount = prevMeshCountRef.current;
    const currentMeshCount = geometryResult?.meshes?.length ?? 0;
    const hasGeometry = currentMeshCount > 0;

    // Track panel visibility separately from overlay
    const panelJustOpened = panelVisible && !wasVisible;
    const overlayJustEnabled = displayOptions.show3DOverlay && !wasOverlayEnabled;
    const isNowActive = panelVisible || displayOptions.show3DOverlay;
    const geometryChanged = currentMeshCount !== prevMeshCount;

    // Always update refs
    prevPanelVisibleRef.current = panelVisible;
    prevOverlayEnabledRef.current = displayOptions.show3DOverlay;
    prevMeshCountRef.current = currentMeshCount;

    if (isNowActive) {
      if (!hasGeometry) {
        // No geometry available - clear the drawing
        if (drawing) {
          setDrawing(null);
          setDrawingStatus('idle');
        }
      } else if (panelJustOpened || overlayJustEnabled || !drawing || geometryChanged) {
        // Generate if:
        // 1. Panel just opened, OR
        // 2. Overlay just enabled, OR
        // 3. No drawing exists, OR
        // 4. Geometry changed significantly (models hidden/shown)
        generateDrawing();
      }
    }
  }, [panelVisible, displayOptions.show3DOverlay, drawing, geometryResult, generateDrawing, setDrawing, setDrawingStatus]);

  // Auto-regenerate when section plane changes
  // Strategy: INSTANT - no debounce, but prevent overlapping computations
  // The generation time itself acts as natural batching for fast slider movements
  const sectionRef = useRef<{ axis: 'down' | 'front' | 'side'; position: number; flipped: boolean; normalKey: string }>({
    axis: sectionPlane.axis,
    position: sectionPlane.position,
    flipped: sectionPlane.flipped,
    normalKey: sectionPlane.normal ? sectionPlane.normal.join(',') : '',
  });
  const isGeneratingRef = useRef(false);
  const latestSectionRef = useRef<{ axis: 'down' | 'front' | 'side'; position: number; flipped: boolean; normalKey: string }>({
    axis: sectionPlane.axis,
    position: sectionPlane.position,
    flipped: sectionPlane.flipped,
    normalKey: sectionPlane.normal ? sectionPlane.normal.join(',') : '',
  });
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Stable regenerate function that handles overlapping calls
  const doRegenerate = useCallback(async () => {
    if (isGeneratingRef.current) {
      // Already generating - the latest position is already tracked in latestSectionRef
      // When current generation finishes, it will check if another is needed
      return;
    }

    isGeneratingRef.current = true;
    setIsRegenerating(true);

    // Capture position at start of generation
    const targetSection = { ...latestSectionRef.current };

    try {
      await generateDrawing(true);
    } finally {
      isGeneratingRef.current = false;
      setIsRegenerating(false);

      // Check if section changed while we were generating — including
      // transitions into/out of custom-normal mode (face-pick), which
      // axis/position/flipped alone can't express.
      const current = latestSectionRef.current;
      if (
        current.axis !== targetSection.axis ||
        current.position !== targetSection.position ||
        current.flipped !== targetSection.flipped ||
        current.normalKey !== targetSection.normalKey
      ) {
        // Position changed during generation - regenerate immediately with latest
        // Use microtask to avoid blocking
        queueMicrotask(() => doRegenerate());
      }
    }
  }, [generateDrawing]);

  // Stable key representing the presence/direction of a custom plane —
  // stringified normal tuple or '' for preset. Lets the effect below notice
  // transitions into/out of custom mode even if the nearest cardinal axis
  // happens to match.
  const normalKey = sectionPlane.normal ? sectionPlane.normal.join(',') : '';

  useEffect(() => {
    // Always update latest section ref (even if generating) — include the
    // normal so the in-flight completion check can notice custom-plane
    // transitions.
    latestSectionRef.current = {
      axis: sectionPlane.axis,
      position: sectionPlane.position,
      flipped: sectionPlane.flipped,
      normalKey,
    };

    // Check if section plane actually changed from last processed
    const prev = sectionRef.current;
    if (
      prev.axis === sectionPlane.axis &&
      prev.position === sectionPlane.position &&
      prev.flipped === sectionPlane.flipped &&
      prev.normalKey === normalKey
    ) {
      return;
    }

    // Update processed ref
    sectionRef.current = {
      axis: sectionPlane.axis,
      position: sectionPlane.position,
      flipped: sectionPlane.flipped,
      normalKey,
    };

    // If panel is visible OR 3D overlay is enabled, and we have geometry, regenerate INSTANTLY
    if ((panelVisible || displayOptions.show3DOverlay) && geometryResult?.meshes) {
      // Start immediately - no debounce
      // doRegenerate handles preventing overlaps and will auto-regenerate with latest when done
      doRegenerate();
    }
  }, [panelVisible, displayOptions.show3DOverlay, sectionPlane.axis, sectionPlane.position, sectionPlane.flipped, normalKey, geometryResult, combinedHiddenIds, combinedIsolatedIds, computedIsolatedIds, doRegenerate]);

  return {
    generateDrawing,
    doRegenerate,
    isRegenerating,
  };
}

export default useDrawingGeneration;
