/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Visibility dropdown body — class toggles, the Model/Types 3D view
 * switch, and the load-time geometry settings — shared by the classic
 * toolbar and the ribbon so the two styles can never drift.
 *
 * Settings-style panel (not a list of menu-items): each row is a plain
 * <label> wrapping a right-aligned Switch, so toggling does NOT close
 * the menu — users routinely flip several classes in one pass. State
 * reads two ways: the switch position and the row dimming when off.
 * All rows render unconditionally (persisted preferences, sticky across
 * models/reloads); toggling a class the model lacks is a no-op.
 */

import React from 'react';
import {
  Box,
  BoxSelect,
  Boxes,
  Building2,
  Grid3x3,
  Layers2,
  Pencil,
  Shapes,
  SquareX,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DropdownMenuContent, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';

interface ClassVisibilityRowProps {
  /** Colored class glyph (caller sets the tint). */
  icon: React.ReactNode;
  label: string;
  /** One-line plain-language hint about what the IFC class covers. */
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * One row of the Visibility panel: colored class icon + label/description
 * on the left, a Switch on the right. The whole row is a <label>, so a
 * click anywhere toggles the switch and — because it isn't a menu item —
 * the dropdown stays open for flipping several classes in a row. The left
 * cluster dims when off so on/off reads from saturation as well as the
 * switch position.
 */
function ClassVisibilityRow({ icon, label, description, checked, onChange }: ClassVisibilityRowProps) {
  return (
    <label className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
      <span className={cn('flex items-center gap-2.5 min-w-0 transition-opacity', !checked && 'opacity-50')}>
        {icon}
        <span className="grid gap-0.5 min-w-0">
          <span className="text-sm leading-tight truncate">{label}</span>
          <span className="text-[10px] leading-tight text-muted-foreground truncate">{description}</span>
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * How many of the class toggles are on — surfaced in the menu header
 * (and on ribbon trigger tooltips) so the user sees scene state at a
 * glance.
 */
export function useVisibleClassCount(): { visible: number; total: number } {
  const typeVisibility = useViewerStore((state) => state.typeVisibility);
  const toggles = [
    typeVisibility.spaces,
    typeVisibility.spatialZones,
    typeVisibility.openings,
    typeVisibility.virtualElements,
    typeVisibility.site,
    typeVisibility.ifcAnnotations,
    typeVisibility.ifcGrid,
  ];
  return { visible: toggles.filter(Boolean).length, total: toggles.length };
}

export function ClassVisibilityMenuContent({ align = 'start' }: { align?: 'start' | 'end' }) {
  const typeVisibility = useViewerStore((state) => state.typeVisibility);
  const toggleTypeVisibility = useViewerStore((state) => state.toggleTypeVisibility);
  const resetTypeVisibility = useViewerStore((state) => state.resetTypeVisibility);
  // #957 follow-up: Model/Types 3D view switch — 'model' shows placed
  // occurrences (default), 'types' shows the type-library shapes.
  const typeViewMode = useViewerStore((state) => state.typeViewMode);
  const setTypeViewMode = useViewerStore((state) => state.setTypeViewMode);
  // Only models with type-library geometry (RepresentationMap shapes) can show
  // anything in "Types" mode, so the switch is hidden for the common
  // occurrence-only model. Derived in ViewportContainer from the merged meshes.
  const hasTypeGeometry = useViewerStore((state) => state.hasTypeGeometry);
  const mergeLayers = useViewerStore((state) => state.mergeLayers);
  const setMergeLayers = useViewerStore((state) => state.setMergeLayers);
  const geometryMode = useViewerStore((state) => state.geometryMode);
  const setGeometryMode = useViewerStore((state) => state.setGeometryMode);
  const { visible: visibleClassCount, total: classToggleCount } = useVisibleClassCount();

  return (
    <DropdownMenuContent align={align} className="w-[300px] p-1.5">
      {/* Model / Types 3D view switch (#957 follow-up). A type carries a
          RepresentationMap whose shape is drawn at its MappingOrigin; "Types"
          shows that type library, "Model" shows the placed occurrences. The
          two are mutually exclusive — toggling re-filters the cached mesh set
          instantly (no reload). Only rendered when the model actually has
          type-library geometry — most carry only occurrence geometry, where
          "Types" would be empty, so the switch would just be a dead control. */}
      {hasTypeGeometry && (
        <>
          <div className="px-1.5 pb-1 pt-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              3D View
            </span>
          </div>
          <div className="flex gap-1 px-1.5 pb-1.5" role="radiogroup" aria-label="3D view mode">
            <button
              type="button"
              role="radio"
              aria-checked={typeViewMode === 'model'}
              onClick={() => setTypeViewMode('model')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                typeViewMode === 'model'
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted/50',
              )}
            >
              <Boxes className="h-3.5 w-3.5 shrink-0" />
              Model
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={typeViewMode === 'types'}
              onClick={() => setTypeViewMode('types')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                typeViewMode === 'types'
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted/50',
              )}
            >
              <Shapes className="h-3.5 w-3.5 shrink-0" />
              Types
            </button>
          </div>

          <DropdownMenuSeparator className="my-1" />
        </>
      )}

      <div className="flex items-center justify-between gap-2 px-1.5 pb-1 pt-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Visibility
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[11px] tabular-nums text-muted-foreground/80">
            {visibleClassCount}/{classToggleCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            onClick={resetTypeVisibility}
          >
            Reset
          </Button>
        </div>
      </div>

      <ClassVisibilityRow
        icon={<Box className="h-4 w-4 shrink-0" style={{ color: '#33d9ff' }} />}
        label="Spaces"
        description="Room volumes (IfcSpace)"
        checked={typeVisibility.spaces}
        onChange={() => toggleTypeVisibility('spaces')}
      />
      <ClassVisibilityRow
        icon={<Box className="h-4 w-4 shrink-0" style={{ color: '#b85af2' }} />}
        label="Spatial Zones"
        description="Gross-area volumes (IfcSpatialZone)"
        checked={typeVisibility.spatialZones}
        onChange={() => toggleTypeVisibility('spatialZones')}
      />
      <ClassVisibilityRow
        icon={<SquareX className="h-4 w-4 shrink-0" style={{ color: '#ff6b4a' }} />}
        label="Openings"
        description="Door & window voids"
        checked={typeVisibility.openings}
        onChange={() => toggleTypeVisibility('openings')}
      />
      <ClassVisibilityRow
        icon={<BoxSelect className="h-4 w-4 shrink-0" style={{ color: '#9aa0a6' }} />}
        label="Virtual Elements"
        description="Non-physical boundaries & clearance volumes"
        checked={typeVisibility.virtualElements}
        onChange={() => toggleTypeVisibility('virtualElements')}
      />
      <ClassVisibilityRow
        icon={<Building2 className="h-4 w-4 shrink-0" style={{ color: '#66cc4d' }} />}
        label="Site"
        description="Terrain & context"
        checked={typeVisibility.site}
        onChange={() => toggleTypeVisibility('site')}
      />
      <ClassVisibilityRow
        icon={<Pencil className="h-4 w-4 shrink-0" style={{ color: '#e4b400' }} />}
        label="Annotations"
        description="Text, dimensions, leaders"
        checked={typeVisibility.ifcAnnotations}
        onChange={() => toggleTypeVisibility('ifcAnnotations')}
      />
      <ClassVisibilityRow
        icon={<Grid3x3 className="h-4 w-4 shrink-0" style={{ color: '#e4b400' }} />}
        label="Grids"
        description="Structural axes"
        checked={typeVisibility.ifcGrid}
        onChange={() => toggleTypeVisibility('ifcGrid')}
      />

      <DropdownMenuSeparator className="my-1" />

      {/* Merge multilayer walls rebuilds geometry, so unlike the live
          toggles above it only takes effect on the next model load.
          The "· on reload" suffix carries that nuance inline — keeps
          the row identical in shape to the others (no header, no chip
          crowding the long label). */}
      <label className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <span className={cn('flex items-center gap-2.5 min-w-0 transition-opacity', !mergeLayers && 'opacity-50')}>
          <Layers2 className="h-4 w-4 shrink-0 text-primary" />
          <span className="grid gap-0.5 min-w-0">
            <span className="text-sm leading-tight truncate">Merge multilayer walls</span>
            <span className="text-[10px] leading-tight text-muted-foreground truncate">
              Render walls as one solid · on reload
            </span>
          </span>
        </span>
        <Switch checked={mergeLayers} onCheckedChange={(next) => setMergeLayers(next === true)} />
      </label>

      {/* Fast vs Exact geometry — like merge-layers, a load-time geometry
          input that only takes effect on the next model load ("· on reload").
          Fast skips sub-10% detail cuts + auto-lowers density on heavy models
          for quick first paint; Exact keeps every cut at full density for
          display/measure/export fidelity. */}
      <label className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <span className={cn('flex items-center gap-2.5 min-w-0 transition-opacity', geometryMode !== 'fast' && 'opacity-50')}>
          <Zap className="h-4 w-4 shrink-0 text-primary" />
          <span className="grid gap-0.5 min-w-0">
            <span className="text-sm leading-tight truncate">Fast geometry</span>
            <span className="text-[10px] leading-tight text-muted-foreground truncate">
              {geometryMode === 'fast'
                ? 'Skip tiny cuts, auto-detail · on reload'
                : 'Exact: full cuts + density · on reload'}
            </span>
          </span>
        </span>
        <Switch
          checked={geometryMode === 'fast'}
          onCheckedChange={(next) => setGeometryMode(next === true ? 'fast' : 'exact')}
        />
      </label>
    </DropdownMenuContent>
  );
}
