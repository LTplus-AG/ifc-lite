/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material display component for IFC element materials.
 * Handles all IFC material types: direct, layer sets, profile sets,
 * constituent sets, and material lists.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Layers } from 'lucide-react';
import type { MaterialInfo } from '@ifc-lite/parser';

const TYPE_LABELS: Record<string, string> = {
  Material: 'Material',
  MaterialLayerSet: 'Layer Set',
  MaterialProfileSet: 'Profile Set',
  MaterialConstituentSet: 'Constituent Set',
  MaterialList: 'Material List',
};

export function MaterialCard({ material }: { material: MaterialInfo }) {
  const typeLabel = TYPE_LABELS[material.type] || material.type;
  const displayName = material.name || typeLabel;

  return (
    <Collapsible defaultOpen className="border-2 border-amber-200 dark:border-amber-800 bg-amber-50/20 dark:bg-amber-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-amber-50 dark:hover:bg-amber-900/30 text-left transition-colors overflow-hidden">
        <Layers className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="font-bold text-xs text-amber-700 dark:text-amber-400 truncate flex-1 min-w-0">
          {displayName}
        </span>
        <span className="text-[10px] font-mono bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 shrink-0">
          {typeLabel}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-amber-200 dark:border-amber-800 divide-y divide-amber-100 dark:divide-amber-900/30">
          {/* Direct material */}
          {material.type === 'Material' && (
            <>
              {material.name && (
                <MaterialRow label="Name" value={material.name} />
              )}
              {material.description && (
                <MaterialRow label="Description" value={material.description} />
              )}
            </>
          )}

          {/* Layer Set */}
          {material.type === 'MaterialLayerSet' && material.layers && (
            <>
              {material.name && <MaterialRow label="Set Name" value={material.name} />}
              {material.layers.map((layer, i) => (
                <div key={i} className="px-3 py-2 text-xs hover:bg-amber-50/50 dark:hover:bg-amber-900/20">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      Layer {i + 1}
                    </span>
                    {layer.thickness !== undefined && (
                      <span className="text-[10px] font-mono bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 border border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-300">
                        {formatThickness(layer.thickness)}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-[minmax(60px,auto)_1fr] gap-x-2 gap-y-0.5 ml-2">
                    {layer.materialName && (
                      <>
                        <span className="text-zinc-400">Material</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{layer.materialName}</span>
                      </>
                    )}
                    {layer.name && (
                      <>
                        <span className="text-zinc-400">Name</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{layer.name}</span>
                      </>
                    )}
                    {layer.category && (
                      <>
                        <span className="text-zinc-400">Category</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{layer.category}</span>
                      </>
                    )}
                    {layer.isVentilated && (
                      <>
                        <span className="text-zinc-400">Ventilated</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400">Yes</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Profile Set */}
          {material.type === 'MaterialProfileSet' && material.profiles && (
            <>
              {material.name && <MaterialRow label="Set Name" value={material.name} />}
              {material.profiles.map((profile, i) => (
                <div key={i} className="px-3 py-2 text-xs hover:bg-amber-50/50 dark:hover:bg-amber-900/20">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      Profile {i + 1}
                    </span>
                  </div>
                  <div className="grid grid-cols-[minmax(60px,auto)_1fr] gap-x-2 gap-y-0.5 ml-2">
                    {profile.materialName && (
                      <>
                        <span className="text-zinc-400">Material</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{profile.materialName}</span>
                      </>
                    )}
                    {profile.name && (
                      <>
                        <span className="text-zinc-400">Name</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{profile.name}</span>
                      </>
                    )}
                    {profile.category && (
                      <>
                        <span className="text-zinc-400">Category</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{profile.category}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Constituent Set */}
          {material.type === 'MaterialConstituentSet' && material.constituents && (
            <>
              {material.name && <MaterialRow label="Set Name" value={material.name} />}
              {material.constituents.map((constituent, i) => (
                <div key={i} className="px-3 py-2 text-xs hover:bg-amber-50/50 dark:hover:bg-amber-900/20">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      {constituent.name || `Constituent ${i + 1}`}
                    </span>
                    {constituent.fraction !== undefined && (
                      <span className="text-[10px] font-mono bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 border border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-300">
                        {(constituent.fraction * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-[minmax(60px,auto)_1fr] gap-x-2 gap-y-0.5 ml-2">
                    {constituent.materialName && (
                      <>
                        <span className="text-zinc-400">Material</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{constituent.materialName}</span>
                      </>
                    )}
                    {constituent.category && (
                      <>
                        <span className="text-zinc-400">Category</span>
                        <span className="font-mono text-amber-700 dark:text-amber-400 break-words">{constituent.category}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Material List */}
          {material.type === 'MaterialList' && material.materials && (
            <>
              {material.materials.map((m, i) => (
                <MaterialRow key={i} label={`Material ${i + 1}`} value={m.name} />
              ))}
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MaterialRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-amber-50/50 dark:hover:bg-amber-900/20">
      <span className="text-zinc-500 dark:text-zinc-400 font-medium">{label}</span>
      <span className="font-mono text-amber-700 dark:text-amber-400 select-all break-words">{value}</span>
    </div>
  );
}

function formatThickness(thickness: number): string {
  if (thickness <= 0) return `${thickness.toFixed(1)} m`;
  if (thickness >= 1) {
    return `${thickness.toFixed(1)} m`;
  }
  // Show in mm for sub-meter thicknesses
  const mm = thickness * 1000;
  return `${mm.toFixed(1)} mm`;
}
