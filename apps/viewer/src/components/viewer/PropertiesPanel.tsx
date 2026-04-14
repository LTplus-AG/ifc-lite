/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  Copy,
  Check,
  Focus,
  EyeOff,
  Eye,
  Building2,
  Layers,
  FileText,
  Calculator,
  Tag,
  MousePointer2,
  ArrowUpDown,
  FileBox,
  PenLine,
  Crosshair,
} from 'lucide-react';
import { EditToolbar } from './PropertyEditor';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useIfc } from '@/hooks/useIfc';
import { getNativeEntityDetails } from '@/services/desktop-native-metadata';
import { configureMutationView } from '@/utils/configureMutationView';
import { IfcQuery } from '@ifc-lite/query';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { extractClassificationsOnDemand, extractMaterialsOnDemand, extractTypePropertiesOnDemand, extractTypeEntityOwnProperties, extractDocumentsOnDemand, extractRelationshipsOnDemand, extractGeoreferencingOnDemand, extractLengthUnitScale, type IfcDataStore } from '@ifc-lite/parser';
import { EntityFlags, RelationshipType, isSpatialStructureTypeName, isStoreyLikeSpatialTypeName } from '@ifc-lite/data';
import type { EntityRef, FederatedModel } from '@/store/types';

import { CoordVal, CoordRow } from './properties/CoordinateDisplay';
import { PropertySetCard } from './properties/PropertySetCard';
import { QuantitySetCard } from './properties/QuantitySetCard';
import { ModelMetadataPanel } from './properties/ModelMetadataPanel';
import { ClassificationCard } from './properties/ClassificationCard';
import { MaterialCard } from './properties/MaterialCard';
import { DocumentCard } from './properties/DocumentCard';
import { RelationshipsCard } from './properties/RelationshipsCard';
import type { PropertySet, QuantitySet } from './properties/encodingUtils';
import { BsddCard } from './properties/BsddCard';
import { GeoreferencingPanel } from './properties/GeoreferencingPanel';

type DisplayProperty = { name: string; value: unknown; isMutated: boolean };
type DisplayPropertySet = {
  name: string;
  properties: DisplayProperty[];
  isNewPset: boolean;
  source?: PropertySet['source'];
};

function mergePropertySetLists(base: DisplayPropertySet[], incoming: DisplayPropertySet[]): DisplayPropertySet[] {
  const merged = base.map(pset => ({
    ...pset,
    properties: [...pset.properties],
  }));
  const psetMap = new Map(merged.map(pset => [pset.name, pset]));

  for (const incomingPset of incoming) {
    const existing = psetMap.get(incomingPset.name);
    if (!existing) {
      const copy = {
        ...incomingPset,
        properties: [...incomingPset.properties],
      };
      merged.push(copy);
      psetMap.set(copy.name, copy);
      continue;
    }

    const existingPropMap = new Map(existing.properties.map(prop => [prop.name, prop]));
    for (const prop of incomingPset.properties) {
      if (!existingPropMap.has(prop.name)) {
        existing.properties.push(prop as DisplayProperty);
      }
    }
  }

  return merged;
}

export function PropertiesPanel() {
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const selectedEntities = useViewerStore((s) => s.selectedEntities);
  const selectedModelId = useViewerStore((s) => s.selectedModelId);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const toggleEntityVisibility = useViewerStore((s) => s.toggleEntityVisibility);
  const isEntityVisible = useViewerStore((s) => s.isEntityVisible);
  const { query, ifcDataStore, geometryResult, models, getQueryForModel } = useIfc();

  // Get model-aware query based on selectedEntity
  const { modelQuery, model } = useMemo(() => {
    // If we have a selectedEntity with modelId, use that model's query
    if (selectedEntity && selectedEntity.modelId !== 'legacy') {
      const m = models.get(selectedEntity.modelId);
      if (m) {
        return {
          modelQuery: m.nativeMetadata ? null : (m.ifcDataStore ? new IfcQuery(m.ifcDataStore) : null),
          model: m,
        };
      }
    }
    // Fallback to legacy query
    return { modelQuery: query, model: null };
  }, [selectedEntity, models, query]);

  // Use model-aware data store
  const activeDataStore = model?.ifcDataStore ?? ifcDataStore;

  // Subscribe to mutation views and version to trigger re-render when mutations change
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);

  // Ensure mutation view exists for editing - creates it on-demand if needed
  useEffect(() => {
    if (!model || !model.ifcDataStore || !selectedEntity || selectedEntity.modelId === 'legacy') return;

    const modelId = selectedEntity.modelId;
    let mutationView = getMutationView(modelId);
    if (mutationView) return; // Already exists

    // Create new mutation view
    const dataStore = model.ifcDataStore;
    mutationView = new MutablePropertyView(dataStore.properties || null, modelId);

    configureMutationView(mutationView, dataStore as IfcDataStore);

    registerMutationView(modelId, mutationView);
  }, [model, selectedEntity, getMutationView, registerMutationView]);

  // Copy feedback state - must be before any early returns (Rules of Hooks)
  const [copied, setCopied] = useState(false);
  const [coordCopied, setCoordCopied] = useState<string | null>(null);
  const [coordOpen, setCoordOpen] = useState(false);
  const [nativeDetails, setNativeDetails] = useState<import('@/store/types').NativeMetadataEntityDetails | null>(null);
  const [nativeDetailsState, setNativeDetailsState] = useState<'idle' | 'loading' | 'error'>('idle');

  // Edit mode toggle - allows inline property editing
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    if (!selectedEntity || !model?.nativeMetadata) {
      setNativeDetails(null);
      setNativeDetailsState('idle');
      return;
    }
    let cancelled = false;
    setNativeDetailsState('loading');
    void getNativeEntityDetails(model.nativeMetadata.cacheKey, selectedEntity.expressId)
      .then((details) => {
        if (!cancelled) {
          setNativeDetails(details);
          setNativeDetailsState('idle');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNativeDetails(null);
          setNativeDetailsState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEntity, model?.nativeMetadata]);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  const copyCoords = useCallback((label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCoordCopied(label);
    setTimeout(() => setCoordCopied(null), 1500);
  }, []);

  // Get spatial location info
  // IMPORTANT: Use selectedEntity.expressId (original ID) for IfcDataStore lookups
  // selectedEntityId is a globalId which only works with offset=0 (first model)
  const spatialInfo = useMemo(() => {
    const originalExpressId = selectedEntity?.expressId;
    if (!originalExpressId || !activeDataStore?.spatialHierarchy) return null;

    const hierarchy = activeDataStore.spatialHierarchy;
    // Use O(1) lookup instead of O(n) includes() search
    const storeyId = hierarchy.elementToStorey.get(originalExpressId);

    if (!storeyId) return null;

    // Get height: try pre-computed, then properties/quantities, then calculate from elevations
    let height = hierarchy.storeyHeights?.get(storeyId);

    if (height === undefined && activeDataStore.properties) {
      for (const pset of activeDataStore.properties.getForEntity(storeyId)) {
        for (const prop of pset.properties) {
          const propName = prop.name.toLowerCase();
          if (['grossheight', 'netheight', 'height'].includes(propName)) {
            const val = parseFloat(String(prop.value));
            if (!isNaN(val) && val > 0) {
              height = val;
              break;
            }
          }
        }
        if (height !== undefined) break;
      }
    }

    if (height === undefined && activeDataStore.quantities) {
      for (const qto of activeDataStore.quantities.getForEntity(storeyId)) {
        for (const qty of qto.quantities) {
          const qtyName = qty.name.toLowerCase();
          if (['grossheight', 'netheight', 'height'].includes(qtyName) && typeof qty.value === 'number' && qty.value > 0) {
            height = qty.value;
            break;
          }
        }
        if (height !== undefined) break;
      }
    }

    // Fallback: calculate from elevation difference to next storey
    if (height === undefined && hierarchy.storeyElevations.size > 1) {
      const currentElevation = hierarchy.storeyElevations.get(storeyId);
      if (currentElevation !== undefined) {
        // Find next storey with higher elevation (O(n) but only when height missing)
        let nextElevation: number | undefined;
        for (const [, elev] of hierarchy.storeyElevations) {
          if (elev > currentElevation && (nextElevation === undefined || elev < nextElevation)) {
            nextElevation = elev;
          }
        }
        if (nextElevation !== undefined) {
          height = nextElevation - currentElevation;
        }
      }
    }

    return {
      storeyId,
      storeyName: activeDataStore.entities.getName(storeyId) || `Storey #${storeyId}`,
      elevation: hierarchy.storeyElevations.get(storeyId),
      height,
    };
  }, [selectedEntity, activeDataStore]);

  // Compute entity bounding box and coordinates (local scene + world)
  //
  // The full coordinate pipeline is:
  //   1. WASM extracts IFC positions (Z-up) and applies RTC offset (wasmRtcOffset, in Z-up)
  //   2. Mesh collector converts Z-up -> Y-up: newY = oldZ, newZ = -oldY
  //   3. CoordinateHandler may apply additional originShift (in Y-up) for large coordinates
  //   4. Multi-model alignment adjusts positions so all models share the first model's RTC frame
  //
  // To reverse back to world coordinates (Y-up):
  //   world_yup = scene_local + originShift + wasmRtcOffset_converted_to_yup
  //
  // For multi-model: all models are aligned to the first model's RTC frame,
  // so we always use the first model's wasmRtcOffset for reconstruction.
  const entityCoordinates = useMemo(() => {
    if (!selectedEntity) return null;

    // Get geometry source: prefer multi-model, fallback to legacy
    const geoResult = model?.geometryResult ?? geometryResult;
    if (!geoResult?.meshes?.length) return null;

    // In multi-model mode, meshes use globalIds (originalExpressId + idOffset)
    const targetExpressId = toGlobalIdFromModels(models, selectedEntity.modelId, selectedEntity.expressId);

    // Compute bounding box from matching mesh positions
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let found = false;

    for (const mesh of geoResult.meshes) {
      if (mesh.expressId !== targetExpressId) continue;
      found = true;
      const pos = mesh.positions;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    if (!found) return null;

    const coordInfo = geoResult.coordinateInfo;
    const shift = coordInfo?.originShift ?? { x: 0, y: 0, z: 0 };

    // Get the reference WASM RTC offset for world coordinate reconstruction.
    // For multi-model: all models are aligned to the first model's RTC frame,
    // so we must use the first model's wasmRtcOffset (not the current model's).
    // For single/legacy: use the geometry result's own offset.
    let wasmRtcIfc = coordInfo?.wasmRtcOffset;
    if (models.size > 1) {
      let earliest = Infinity;
      for (const [, m] of models) {
        if (m.loadedAt < earliest) {
          earliest = m.loadedAt;
          wasmRtcIfc = m.geometryResult?.coordinateInfo?.wasmRtcOffset;
        }
      }
    }

    // Convert WASM RTC offset from IFC Z-up to viewer Y-up:
    //   viewer X = IFC X, viewer Y = IFC Z, viewer Z = -IFC Y
    const wasmRtcYup = wasmRtcIfc
      ? { x: wasmRtcIfc.x, y: wasmRtcIfc.z, z: -wasmRtcIfc.y }
      : { x: 0, y: 0, z: 0 };

    // Local (scene) center - what the renderer uses (Y-up, shifted)
    const localCenter = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    };

    // World center (Y-up) = scene_local + originShift + wasmRtcOffset_yup
    const worldCenterYup = {
      x: localCenter.x + shift.x + wasmRtcYup.x,
      y: localCenter.y + shift.y + wasmRtcYup.y,
      z: localCenter.z + shift.z + wasmRtcYup.z,
    };

    // Convert world Y-up to IFC Z-up for display:
    //   IFC X = viewer X, IFC Y = -viewer Z, IFC Z = viewer Y
    const worldCenterZup = {
      x: worldCenterYup.x,
      y: -worldCenterYup.z,
      z: worldCenterYup.y,
    };

    return {
      local: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, center: localCenter },
      worldYup: { center: worldCenterYup },
      worldZup: { center: worldCenterZup },
      hasLargeCoordinates: (coordInfo?.hasLargeCoordinates ?? false) || !!wasmRtcIfc,
    };
  }, [selectedEntity, model, geometryResult, models]);

  // Get entity node - must be computed before early return to maintain hook order
  // IMPORTANT: Use selectedEntity.expressId (original ID) for IfcDataStore lookups
  const entityNode = useMemo(() => {
    const originalExpressId = selectedEntity?.expressId;
    if (!originalExpressId || !modelQuery) return null;
    return modelQuery.entity(originalExpressId);
  }, [selectedEntity, modelQuery]);

  // Check if the selected entity is a type entity (IfcWallType, etc.)
  // Uses the entity type name to detect — type entity names end with "Type"
  const isTypeEntity = useMemo(() => {
    if (!selectedEntity) return false;
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore?.entities) return false;
    const typeName = dataStore.entities.getTypeName(selectedEntity.expressId);
    return typeName.endsWith('Type');
  }, [selectedEntity, model, ifcDataStore]);

  // Unified property/quantity access - EntityNode handles on-demand extraction automatically
  // These hooks must be called before any early return to maintain hook order
  // Use MutablePropertyView as primary source when available (it handles base + mutations)
  const properties: PropertySet[] = useMemo(() => {
    let modelId = selectedEntity?.modelId;
    const expressId = selectedEntity?.expressId;

    // Normalize legacy model ID (selection uses 'legacy', mutation views use '__legacy__')
    if (modelId === 'legacy') {
      modelId = '__legacy__';
    }

    // Try to get properties from mutation view first (handles both base and mutations)
    const mutationView = modelId ? mutationViews.get(modelId) : null;

    if (mutationView && expressId) {
      // Get merged properties from mutation view (base + mutations applied)
      const mergedProps = mutationView.getForEntity(expressId);

      // Get list of actual mutations to track which properties changed
      const mutations = mutationView.getMutationsForEntity(expressId);

      // Build a set of mutated property keys for quick lookup
      const mutatedKeys = new Set<string>();
      const newPsetNames = new Set<string>();
      for (const m of mutations) {
        if (m.psetName && m.propName) {
          mutatedKeys.add(`${m.psetName}:${m.propName}`);
        }
        // Track property sets that were created (not in original model)
        if (m.type === 'CREATE_PROPERTY_SET' && m.psetName) {
          newPsetNames.add(m.psetName);
        }
        // Also mark as new pset if this is a CREATE_PROPERTY for a pset that doesn't exist in base
        if (m.type === 'CREATE_PROPERTY' && m.psetName) {
          // Check if we have base properties to compare
          const baseProps = entityNode?.properties() ?? [];
          const existsInBase = baseProps.some(p => p.name === m.psetName);
          if (!existsInBase) {
            newPsetNames.add(m.psetName);
          }
        }
      }

      // If mutation view returned properties, use them
      if (mergedProps.length > 0) {
        return mergedProps.map(pset => ({
          name: pset.name,
          properties: pset.properties.map(p => ({
            name: p.name,
            value: p.value,
            isMutated: mutatedKeys.has(`${pset.name}:${p.name}`),
          })),
          isNewPset: newPsetNames.has(pset.name),
        }));
      }
    }

    // Fallback to entity node properties (no mutations or mutation view not available)
    if (!entityNode) return [];

    const rawProps = entityNode.properties();
    let result = rawProps.map(pset => ({
      name: pset.name,
      properties: pset.properties.map(p => ({ name: p.name, value: p.value, isMutated: false })),
      isNewPset: false,
    }));

    // For type entities, also extract HasPropertySets (attribute[5]) since they
    // aren't linked via IfcRelDefinesByProperties and thus not in onDemandPropertyMap
    if (isTypeEntity && expressId) {
      const dataStore = (activeDataStore ?? ifcDataStore) as IfcDataStore | null;
      if (dataStore) {
        const typeOwnProps = extractTypeEntityOwnProperties(dataStore, expressId);
        const mappedTypeOwn = typeOwnProps.map(pset => ({
          name: pset.name,
          properties: pset.properties.map(p => ({ name: p.name, value: p.value, isMutated: false })),
          isNewPset: false,
        }));
        result = mergePropertySetLists(result, mappedTypeOwn);
      }
    }

    return result;
  }, [entityNode, selectedEntity, mutationViews, mutationVersion, isTypeEntity, activeDataStore, ifcDataStore]);

  const quantities: QuantitySet[] = useMemo(() => {
    let modelId = selectedEntity?.modelId;
    const expressId = selectedEntity?.expressId;

    if (modelId === 'legacy') modelId = '__legacy__';

    // Try mutation view first to include added quantities from bSDD
    const mutationView = modelId ? mutationViews.get(modelId) : null;
    if (mutationView && expressId) {
      const merged = mutationView.getQuantitiesForEntity(expressId);
      if (merged.length > 0) return merged;
    }

    // Fallback to entity node quantities
    if (!entityNode) return [];
    return entityNode.quantities();
  }, [entityNode, selectedEntity, mutationViews, mutationVersion]);

  // Build attributes array for display - must be before early return to maintain hook order
  // Uses schema-aware extraction to show ALL string/enum attributes for the entity type.
  // Merges mutated attributes (from bSDD) into the base attribute list.
  // Note: GlobalId is intentionally excluded since it's shown in the dedicated GUID field above
  const attributes = useMemo(() => {
    const base = entityNode ? entityNode.allAttributes() : [];

    // Merge mutated attributes from bSDD
    let modelId = selectedEntity?.modelId;
    const expressId = selectedEntity?.expressId;
    if (modelId === 'legacy') modelId = '__legacy__';
    const mutationView = modelId ? mutationViews.get(modelId) : null;
    if (mutationView && expressId) {
      const mutatedAttrs = mutationView.getAttributeMutationsForEntity(expressId);
      if (mutatedAttrs.length > 0) {
        const baseNames = new Set(base.map(a => a.name));
        const merged = [...base];
        for (const ma of mutatedAttrs) {
          if (baseNames.has(ma.name)) {
            // Update existing attribute value
            const idx = merged.findIndex(a => a.name === ma.name);
            if (idx >= 0) merged[idx] = { name: ma.name, value: ma.value };
          } else {
            // Add new attribute
            merged.push({ name: ma.name, value: ma.value });
          }
        }
        return merged;
      }
    }

    return base;
  }, [entityNode, selectedEntity, mutationViews, mutationVersion]);

  // Extract classifications for the selected entity from the IFC data store
  const classifications = useMemo(() => {
    if (!selectedEntity) return [];
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) return [];
    return extractClassificationsOnDemand(dataStore as IfcDataStore, selectedEntity.expressId);
  }, [selectedEntity, model, ifcDataStore]);

  // Extract materials for the selected entity from the IFC data store
  const materialInfo = useMemo(() => {
    if (!selectedEntity) return null;
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) return null;
    return extractMaterialsOnDemand(dataStore as IfcDataStore, selectedEntity.expressId);
  }, [selectedEntity, model, ifcDataStore]);

  // Extract documents for the selected entity from the IFC data store
  const documents = useMemo(() => {
    if (!selectedEntity) return [];
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) return [];
    return extractDocumentsOnDemand(dataStore as IfcDataStore, selectedEntity.expressId);
  }, [selectedEntity, model, ifcDataStore]);

  // Extract structural relationships (openings, fills, groups, connections)
  const entityRelationships = useMemo(() => {
    if (!selectedEntity) return null;
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) return null;
    const rels = extractRelationshipsOnDemand(dataStore as IfcDataStore, selectedEntity.expressId);
    const totalCount = rels.voids.length + rels.fills.length + rels.groups.length + rels.connections.length;
    return totalCount > 0 ? rels : null;
  }, [selectedEntity, model, ifcDataStore]);

  // Extract georeferencing info for the model (used in coordinates section)
  const georef = useMemo(() => {
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) return null;
    const info = extractGeoreferencingOnDemand(dataStore as IfcDataStore);
    return info?.hasGeoreference ? info : null;
  }, [model, ifcDataStore]);

  // Extract IFC length unit scale (e.g. 0.001 for mm, 0.3048 for ft)
  const lengthUnitScale = useMemo(() => {
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore?.source?.length || !dataStore?.entityIndex) return 1;
    return extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
  }, [model, ifcDataStore]);

  // Extract type-level properties (e.g., from IfcWallType's HasPropertySets)
  const typeProperties = useMemo(() => {
    if (!selectedEntity) return null;
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) return null;
    const result = extractTypePropertiesOnDemand(dataStore as IfcDataStore, selectedEntity.expressId);
    if (!result) return null;

    let modelId = selectedEntity.modelId;
    if (modelId === 'legacy') modelId = '__legacy__';
    const mutationView = modelId ? mutationViews.get(modelId) : null;
    const mutations = mutationView?.getMutationsForEntity(result.typeId) ?? [];
    const mergedTypeProps = mutationView?.getForEntity(result.typeId) ?? [];

    const mutatedKeys = new Set<string>();
    const newPsetNames = new Set<string>();
    for (const mutation of mutations) {
      if (mutation.psetName && mutation.propName) {
        mutatedKeys.add(`${mutation.psetName}:${mutation.propName}`);
      }
      if (mutation.type === 'CREATE_PROPERTY_SET' && mutation.psetName) {
        newPsetNames.add(mutation.psetName);
      }
      if (mutation.type === 'CREATE_PROPERTY' && mutation.psetName) {
        const existsInBase = result.properties.some(pset => pset.name === mutation.psetName);
        if (!existsInBase) {
          newPsetNames.add(mutation.psetName);
        }
      }
    }

    const sourcePsets = mergedTypeProps.length > 0
      ? mergedTypeProps
      : result.properties.map(pset => ({
          name: pset.name,
          globalId: pset.globalId || '',
          properties: pset.properties.map(p => ({
            name: p.name,
            type: p.type,
            value: p.value,
          })),
        }));

    return {
      typeName: result.typeName,
      typeId: result.typeId,
      psets: sourcePsets.map(pset => ({
        name: pset.name,
        properties: pset.properties.map(p => ({
          name: p.name,
          value: p.value,
          isMutated: mutatedKeys.has(`${pset.name}:${p.name}`),
        })),
        isNewPset: newPsetNames.has(pset.name),
      })),
    };
  }, [selectedEntity, model, ifcDataStore, mutationViews, mutationVersion]);

  // Spatial containment info for spatial containers (Project, Facility, Part, Storey, Space)
  const spatialContainment = useMemo(() => {
    if (!selectedEntity) return null;
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore?.spatialHierarchy) return null;

    const expressId = selectedEntity.expressId;
    const hierarchy = dataStore.spatialHierarchy;
    const typeName = dataStore.entities.getTypeName(expressId);

    // Only show for spatial structure elements.
    if (!isSpatialStructureTypeName(typeName)) return null;

    const stats: Array<{ label: string; value: string | number }> = [];

    // Find the SpatialNode for this entity
    const findNode = (node: { expressId: number; children: { expressId: number; children: unknown[]; elements: number[]; name: string; type: number }[]; elements: number[]; name: string; type: number }, targetId: number): typeof node | null => {
      if (node.expressId === targetId) return node;
      for (const child of node.children) {
        const found = findNode(child as typeof node, targetId);
        if (found) return found;
      }
      return null;
    };
    const spatialNode = findNode(hierarchy.project as Parameters<typeof findNode>[0], expressId);

    if (spatialNode) {
      // Direct children (spatial sub-structure)
      if (spatialNode.children.length > 0) {
        const childTypes = new Map<string, number>();
        for (const child of spatialNode.children) {
          const ct = dataStore.entities.getTypeName(child.expressId);
          childTypes.set(ct, (childTypes.get(ct) || 0) + 1);
        }
        for (const [ct, count] of childTypes) {
          stats.push({ label: ct, value: count });
        }
      }
      // Direct contained elements
      if (spatialNode.elements.length > 0) {
        stats.push({ label: 'Contained Elements', value: spatialNode.elements.length });
      }
    }

    // Also count from containment maps
    const mapSources: Array<[string, Map<number, number[]> | undefined]> = [
      ['Elements (Site)', hierarchy.bySite],
      ['Elements (Building-like)', hierarchy.byBuilding],
      ['Elements (Storey)', hierarchy.byStorey],
      ['Elements (Space)', hierarchy.bySpace],
    ];
    for (const [label, map] of mapSources) {
      const elements = map?.get(expressId);
      if (elements && elements.length > 0 && !stats.some(s => s.label === 'Contained Elements')) {
        stats.push({ label, value: elements.length });
      }
    }

    // Elevation for storeys
    if (isStoreyLikeSpatialTypeName(typeName)) {
      const elevation = hierarchy.storeyElevations.get(expressId);
      if (elevation !== undefined) {
        stats.push({ label: 'Elevation', value: `${elevation.toFixed(2)} m` });
      }
    }

    return stats.length > 0 ? stats : null;
  }, [selectedEntity, model, ifcDataStore]);

  // Separate occurrence (instance) and inherited type properties.
  // Occurrence properties are displayed first, type properties in a separate section.
  // All type property sets are always shown in the inherited section so users can see
  // what the type defines, even when the same pset exists at occurrence level.
  const { occurrenceProperties, inheritedTypeProperties } = useMemo(() => {
    const occ: PropertySet[] = properties.map(p => ({ ...p, source: 'instance' as const }));

    if (!typeProperties || typeProperties.psets.length === 0) {
      return { occurrenceProperties: occ, inheritedTypeProperties: [] as PropertySet[] };
    }

    const inherited: PropertySet[] = typeProperties.psets.map(typePset => ({
      ...typePset,
      source: 'type' as const,
    }));

    return { occurrenceProperties: occ, inheritedTypeProperties: inherited };
  }, [properties, typeProperties]);

  const typeEditImpact = useMemo(() => {
    if (!editMode || !selectedEntity) return null;
    const dataStore = model?.ifcDataStore ?? ifcDataStore;
    if (!dataStore?.relationships) return null;

    if (isTypeEntity) {
      const typeId = selectedEntity.expressId;
      const affectedOccurrenceIds = dataStore.relationships.getRelated(
        typeId,
        RelationshipType.DefinesByType,
        'forward'
      );

      return {
        mode: 'type' as const,
        typeId,
        typeEntityName: dataStore.entities.getTypeName(typeId),
        affectedCount: affectedOccurrenceIds.length,
      };
    }

    if (typeProperties && inheritedTypeProperties.length > 0) {
      const affectedOccurrenceIds = dataStore.relationships.getRelated(
        typeProperties.typeId,
        RelationshipType.DefinesByType,
        'forward'
      );

      return {
        mode: 'inherited' as const,
        typeId: typeProperties.typeId,
        typeEntityName: dataStore.entities.getTypeName(typeProperties.typeId),
        affectedCount: affectedOccurrenceIds.length,
      };
    }

    return null;
  }, [editMode, selectedEntity, model, ifcDataStore, isTypeEntity, typeProperties, inheritedTypeProperties]);

  // Combined list of all properties for bSDD deduplication and edit toolbar
  const mergedProperties: PropertySet[] = useMemo(
    () => [...occurrenceProperties, ...inheritedTypeProperties],
    [occurrenceProperties, inheritedTypeProperties]
  );

  // Build a set of existing property keys ("PsetName:PropName") for bSDD deduplication
  const existingProps = useMemo(() => {
    const keys = new Set<string>();
    for (const pset of mergedProperties) {
      for (const prop of pset.properties) {
        keys.add(`${pset.name}:${prop.name}`);
      }
    }
    return keys;
  }, [mergedProperties]);

  // Build a set of existing quantity keys ("QsetName:QuantName") for bSDD deduplication
  const existingQuants = useMemo(() => {
    const keys = new Set<string>();
    for (const qset of quantities) {
      for (const q of qset.quantities) {
        keys.add(`${qset.name}:${q.name}`);
      }
    }
    return keys;
  }, [quantities]);

  // Build a set of existing attribute names for bSDD deduplication
  const existingAttributeNames = useMemo(() => {
    const names = new Set<string>();
    for (const attr of attributes) {
      if (attr.value) names.add(attr.name);
    }
    return names;
  }, [attributes]);

  const isNativeLazySelection = Boolean(selectedEntity && model?.nativeMetadata);

  useEffect(() => {
    if (isNativeLazySelection && editMode) {
      setEditMode(false);
    }
  }, [isNativeLazySelection, editMode]);

  const nativeSpatialInfo = useMemo(() => {
    if (!nativeDetails?.spatial?.storeyName) return null;
    return {
      storeyId: nativeDetails.spatial.storeyId ?? undefined,
      storeyName: nativeDetails.spatial.storeyName,
      elevation: nativeDetails.spatial.elevation ?? undefined,
      height: nativeDetails.spatial.height ?? undefined,
    };
  }, [nativeDetails]);

  const nativeOccurrenceProperties = useMemo<PropertySet[]>(() => {
    if (!nativeDetails) return [];
    return nativeDetails.properties.map((pset) => ({
      name: pset.name,
      properties: pset.properties.map((property) => ({
        name: property.name,
        value: property.value,
        isMutated: false,
      })),
      isNewPset: false,
      source: 'instance' as const,
    }));
  }, [nativeDetails]);

  const nativeQuantities = useMemo<QuantitySet[]>(() => {
    if (!nativeDetails) return [];
    return nativeDetails.quantities.map((qset) => ({
      name: qset.name,
      quantities: qset.quantities.map((quantity) => ({
        name: quantity.name,
        value: quantity.value,
        type: quantity.type ?? 0,
      })),
    }));
  }, [nativeDetails]);

  const renderedEntityType = isNativeLazySelection
    ? (nativeDetails?.summary.type ?? 'Loading...')
    : (entityNode?.type ?? 'Unknown');
  const renderedEntityName = isNativeLazySelection
    ? (nativeDetails?.summary.name ?? `#${selectedEntity?.expressId ?? ''}`)
    : entityNode?.name;
  const renderedEntityGlobalId = isNativeLazySelection
    ? (nativeDetails?.summary.globalId ?? null)
    : entityNode?.globalId;
  const renderedEntityDescription = isNativeLazySelection ? undefined : entityNode?.description;
  const renderedEntityObjectType = isNativeLazySelection ? undefined : entityNode?.objectType;
  const renderedSpatialInfo = isNativeLazySelection ? nativeSpatialInfo : spatialInfo;
  const renderedOccurrenceProperties = isNativeLazySelection ? nativeOccurrenceProperties : occurrenceProperties;
  const renderedInheritedTypeProperties = isNativeLazySelection ? [] : inheritedTypeProperties;
  const renderedMergedProperties = isNativeLazySelection
    ? nativeOccurrenceProperties
    : mergedProperties;
  const renderedQuantities = isNativeLazySelection ? nativeQuantities : quantities;
  const renderedAttributes = isNativeLazySelection ? [] : attributes;
  const renderedClassifications = isNativeLazySelection ? [] : classifications;
  const renderedMaterialInfo = isNativeLazySelection ? null : materialInfo;
  const renderedDocuments = isNativeLazySelection ? [] : documents;
  const renderedEntityRelationships = isNativeLazySelection ? null : entityRelationships;
  const renderedGeoref = isNativeLazySelection ? null : georef;
  const renderedSpatialContainment = isNativeLazySelection ? null : spatialContainment;
  const renderedTypeProperties = isNativeLazySelection
    ? (nativeDetails?.typeSummary
        ? {
            typeName: nativeDetails.typeSummary.name,
            typeId: nativeDetails.typeSummary.expressId,
            psets: [] as PropertySet[],
          }
        : null)
    : typeProperties;
  const renderedTypeEditImpact = isNativeLazySelection ? null : typeEditImpact;
  const renderedIsTypeEntity = isNativeLazySelection
    ? ((nativeDetails?.summary.type ?? '').endsWith('Type'))
    : isTypeEntity;
  const renderedExistingProps = useMemo(() => {
    const keys = new Set<string>();
    for (const pset of renderedMergedProperties) {
      for (const prop of pset.properties) {
        keys.add(`${pset.name}:${prop.name}`);
      }
    }
    return keys;
  }, [renderedMergedProperties]);
  const renderedExistingQuants = useMemo(() => {
    const keys = new Set<string>();
    for (const qset of renderedQuantities) {
      for (const q of qset.quantities) {
        keys.add(`${qset.name}:${q.name}`);
      }
    }
    return keys;
  }, [renderedQuantities]);
  const renderedExistingAttributeNames = useMemo(() => {
    const names = new Set<string>();
    for (const attr of renderedAttributes) {
      if (attr.value) names.add(attr.name);
    }
    return names;
  }, [renderedAttributes]);

  // Model metadata display (when clicking top-level model in hierarchy)
  if (selectedModelId) {
    const selectedModel = models.get(selectedModelId);
    if (selectedModel) {
      return <ModelMetadataPanel model={selectedModel} />;
    }
  }

  // Multi-entity selection (unified storeys) - render combined view
  if (selectedEntities.length > 1) {
    return (
      <MultiEntityPanel
        entities={selectedEntities}
        models={models}
        ifcDataStore={ifcDataStore}
      />
    );
  }

  if (!selectedEntityId || (!isNativeLazySelection && (!modelQuery || !entityNode))) {
    // Show model metadata when a single model is loaded and nothing selected.
    // Handles both federated models (models.size >= 1) and legacy single-model path (models.size === 0).
    if (models.size === 1) {
      const singleModel = models.values().next().value as FederatedModel;
      return <ModelMetadataPanel model={singleModel} />;
    }
    if (ifcDataStore && models.size === 0 && geometryResult) {
      const legacyModel: FederatedModel = {
        id: '__legacy__',
        name: 'Model',
        ifcDataStore: ifcDataStore as IfcDataStore,
        geometryResult,
        visible: true,
        collapsed: false,
        schemaVersion: ((ifcDataStore as IfcDataStore).schemaVersion ?? 'IFC4') as FederatedModel['schemaVersion'],
        loadedAt: Date.now(),
        fileSize: (ifcDataStore as IfcDataStore).fileSize ?? 0,
        idOffset: 0,
        maxExpressId: (ifcDataStore as IfcDataStore).entityCount ?? 0,
      };
      return <ModelMetadataPanel model={legacyModel} />;
    }
    // Multi-model or no model loaded: show empty state
    return (
      <div className="h-full flex flex-col border-l-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">Properties</h2>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-white dark:bg-black">
          <div className="w-16 h-16 border-2 border-dashed border-zinc-300 dark:border-zinc-800 flex items-center justify-center mb-4 bg-zinc-100 dark:bg-zinc-950">
            <MousePointer2 className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
          </div>
          <p className="font-bold uppercase text-zinc-900 dark:text-zinc-100 mb-2">No Selection</p>
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400 max-w-[150px]">
            {models.size > 1 ? 'Select a model or element to view details' : 'Select an element to view details'}
          </p>
        </div>
      </div>
    );
  }

  // These are safe to access after the early return check (entityNode is confirmed non-null above)
  const entityType = renderedEntityType;
  const entityName = renderedEntityName;
  const entityGlobalId = renderedEntityGlobalId;
  const entityDescription = renderedEntityDescription;
  const entityObjectType = renderedEntityObjectType;

  return (
    <div className="h-full flex flex-col border-l-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      {/* Entity Header */}
      <div className="p-4 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 border-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.1)]">
            <Building2 className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="font-bold text-sm truncate uppercase tracking-tight text-zinc-900 dark:text-zinc-100">
              {entityName || `${entityType}`}
            </h3>
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{entityType}</p>
            {/* Show associated type entity for occurrences */}
            {!renderedIsTypeEntity && renderedTypeProperties && (
              <p className="text-[11px] font-mono text-indigo-500 dark:text-indigo-400 truncate" title={`${activeDataStore?.entities.getTypeName(renderedTypeProperties.typeId) || 'Type'}: ${renderedTypeProperties.typeName}`}>
                <Building2 className="inline h-3 w-3 mr-1 -mt-0.5" />
                {activeDataStore?.entities.getTypeName(renderedTypeProperties.typeId) || 'Type'}: {renderedTypeProperties.typeName}
              </p>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-none hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  onClick={() => {
                    if (selectedEntityId && cameraCallbacks.frameSelection) {
                      cameraCallbacks.frameSelection();
                    }
                  }}
                >
                  <Focus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom to</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-none hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  onClick={() => {
                    if (selectedEntityId) {
                      toggleEntityVisibility(selectedEntityId);
                    }
                  }}
                >
                  {selectedEntityId && isEntityVisible(selectedEntityId) ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {selectedEntityId && isEntityVisible(selectedEntityId) ? 'Hide' : 'Show'}
              </TooltipContent>
            </Tooltip>
            {/* Edit mode toggle */}
            {!isNativeLazySelection && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={editMode ? 'default' : 'ghost'}
                    size="icon-xs"
                    className={`rounded-none ${editMode ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'hover:bg-zinc-200 dark:hover:bg-zinc-700'}`}
                    onClick={() => setEditMode(!editMode)}
                  >
                    <PenLine className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{editMode ? 'Exit Edit Mode' : 'Edit Properties'}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* GlobalId */}
        {entityGlobalId && (
          <div className={`flex items-center gap-0 border transition-colors duration-200 ${
            copied
              ? 'border-emerald-400 dark:border-emerald-600'
              : 'border-zinc-200 dark:border-zinc-800'
          }`}>
            <code className="flex-1 text-[10px] bg-white dark:bg-zinc-950 px-2 py-1 truncate font-mono select-all text-zinc-900 dark:text-zinc-100">
              {entityGlobalId}
            </code>
            <Button
              variant="ghost"
              size="icon-xs"
              className={`h-6 w-6 rounded-none border-l transition-all duration-200 ${
                copied
                  ? 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400'
                  : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-950'
              }`}
              onClick={() => copyToClipboard(entityGlobalId)}
            >
              {copied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3 text-zinc-600 dark:text-zinc-400" />
              )}
            </Button>
          </div>
        )}

        {/* Spatial Location */}
        {renderedSpatialInfo && (
          <div className="flex items-center gap-2 text-xs border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-900/10 px-2 py-1.5 text-emerald-800 dark:text-emerald-400 min-w-0">
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span className="font-bold uppercase tracking-wide truncate min-w-0 flex-1">{renderedSpatialInfo.storeyName}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {renderedSpatialInfo.elevation !== undefined && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-emerald-600/70 dark:text-emerald-500/70 font-mono whitespace-nowrap">
                      {renderedSpatialInfo.elevation >= 0 ? '+' : ''}{renderedSpatialInfo.elevation.toFixed(2)}m
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Elevation: {renderedSpatialInfo.elevation >= 0 ? '+' : ''}{renderedSpatialInfo.elevation.toFixed(2)}m from ground</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {renderedSpatialInfo.height !== undefined && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-1 text-emerald-500/60 dark:text-emerald-400/60 font-mono text-[10px] whitespace-nowrap">
                      <ArrowUpDown className="h-2.5 w-2.5 shrink-0" />
                      <span className="hidden sm:inline">{renderedSpatialInfo.height.toFixed(2)}m</span>
                      <span className="sm:hidden">{renderedSpatialInfo.height.toFixed(1)}m</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Height: {renderedSpatialInfo.height.toFixed(2)}m to next storey</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        )}

        {/* World coordinates + Georeferencing — single consolidated section */}
        {(entityCoordinates || renderedGeoref || editMode) && (
          <Collapsible open={coordOpen} onOpenChange={setCoordOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full text-xs border border-teal-500/30 px-2 py-1.5 text-teal-800 dark:text-teal-400 min-w-0 text-left group/coord">
              <Crosshair className="h-3.5 w-3.5 shrink-0" />
              <span className="font-bold uppercase tracking-wide shrink-0">World</span>
              {!coordOpen && (
                <>
                  {entityCoordinates && (
                    <span className="font-mono text-[10px] text-teal-600/70 dark:text-teal-500/70 truncate min-w-0 flex-1 tabular-nums">
                      <CoordVal axis="E" value={entityCoordinates.worldZup.center.x} />{' '}
                      <CoordVal axis="N" value={entityCoordinates.worldZup.center.y} />{' '}
                      <CoordVal axis="Z" value={entityCoordinates.worldZup.center.z} />
                    </span>
                  )}
                  {renderedGeoref?.projectedCRS?.name && (
                    <span className="font-mono text-[9px] text-teal-500/60 shrink-0">{renderedGeoref.projectedCRS.name}</span>
                  )}
                  <span className="text-[9px] text-teal-500/0 group-hover/coord:text-teal-500/40 transition-colors shrink-0">details</span>
                </>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {entityCoordinates && (
                <div className="px-2 py-1.5 space-y-0.5">
                  <CoordRow
                    label=""
                    values={[
                      { axis: 'E', value: entityCoordinates.worldZup.center.x },
                      { axis: 'N', value: entityCoordinates.worldZup.center.y },
                      { axis: 'Z', value: entityCoordinates.worldZup.center.z },
                    ]}
                    primary
                    copyLabel="world"
                    coordCopied={coordCopied}
                    onCopy={copyCoords}
                  />
                  <CoordRow
                    label="Local"
                    values={[
                      { axis: 'X', value: entityCoordinates.local.center.x },
                      { axis: 'Y', value: entityCoordinates.local.center.y },
                      { axis: 'Z', value: entityCoordinates.local.center.z },
                    ]}
                    copyLabel="local"
                    coordCopied={coordCopied}
                    onCopy={copyCoords}
                  />
                  <div className="flex items-start gap-1.5">
                    <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider w-[34px] shrink-0 pt-px">Size</span>
                    <span className="font-mono text-[10px] text-muted-foreground/50 tabular-nums">
                      {(entityCoordinates.local.max.x - entityCoordinates.local.min.x).toFixed(2)} x {(entityCoordinates.local.max.y - entityCoordinates.local.min.y).toFixed(2)} x {(entityCoordinates.local.max.z - entityCoordinates.local.min.z).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
              <GeoreferencingPanel
                georef={renderedGeoref}
                modelId={selectedEntity?.modelId === 'legacy' ? '__legacy__' : (model?.id ?? selectedEntity?.modelId)}
                enableEditing
                schemaVersion={activeDataStore?.schemaVersion}
                coordinateInfo={(model?.geometryResult ?? geometryResult)?.coordinateInfo}
                geometryResult={model?.geometryResult ?? geometryResult}
                lengthUnitScale={lengthUnitScale}
              />
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Model Source (when multiple models loaded) - below storey, less prominent */}
        {models.size > 1 && model && (
          <div className="flex items-center gap-2 text-[11px] px-2 py-1 text-zinc-400 dark:text-zinc-500 min-w-0">
            <FileBox className="h-3 w-3 shrink-0" />
            <span className="font-mono truncate min-w-0 flex-1">{model.name}</span>
          </div>
        )}
      </div>

      {/* IFC Attributes */}
      {renderedAttributes.length > 0 && (
        <Collapsible defaultOpen className="border-b">
          <CollapsibleTrigger className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 text-left">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">Attributes</span>
            {editMode && <PenLine className="h-3 w-3 text-purple-500 ml-1" />}
            <span className="text-xs text-muted-foreground ml-auto">{renderedAttributes.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y border-t">
              {renderedAttributes.map((attr) => (
                <div key={attr.name} className="grid grid-cols-[minmax(80px,1fr)_minmax(0,2fr)] gap-2 px-3 py-1.5 text-sm">
                  <span className="text-muted-foreground truncate" title={attr.name}>{attr.name}</span>
                  {editMode && selectedEntity ? (
                    <AttributeEditorField
                      modelId={selectedEntity.modelId}
                      entityId={selectedEntity.expressId}
                      attrName={attr.name}
                      currentValue={attr.value}
                    />
                  ) : (
                    <div className="overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 min-w-0">
                      <span className="font-medium whitespace-nowrap" title={attr.value}>
                        {attr.value}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Spatial Containment - for spatial containers (Project, Site, Building, Storey) */}
      {renderedSpatialContainment && (
        <Collapsible defaultOpen className="border-b">
          <CollapsibleTrigger className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 text-left">
            <Layers className="h-4 w-4 text-emerald-600" />
            <span className="font-medium text-sm">Structure</span>
            <span className="text-xs text-muted-foreground ml-auto">{renderedSpatialContainment.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y border-t">
              {renderedSpatialContainment.map((item) => (
                <div key={item.label} className="grid grid-cols-[minmax(80px,1fr)_minmax(0,2fr)] gap-2 px-3 py-1.5 text-sm">
                  <span className="text-muted-foreground truncate" title={item.label}>{item.label}</span>
                  <span className="font-medium font-mono">{item.value}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Tabs */}
      <Tabs defaultValue="properties" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="properties-tabs-list w-full shrink-0">
          <TabsTrigger
            value="properties"
            title="Properties"
            className="properties-tab-trigger flex-1 min-w-0 uppercase text-[11px] tracking-wide"
          >
            <FileText className="h-3 w-3 shrink-0 panel-compact-icon" />
            <span className="panel-compact-text">Properties</span>
          </TabsTrigger>
          <TabsTrigger
            value="quantities"
            title="Quantities"
            className="properties-tab-trigger flex-1 min-w-0 uppercase text-[11px] tracking-wide"
          >
            <Calculator className="h-3 w-3 shrink-0 panel-compact-icon" />
            <span className="panel-compact-text">Quantities</span>
          </TabsTrigger>
          <TabsTrigger
            value="bsdd"
            title="bSDD"
            className="properties-tab-trigger flex-1 min-w-0 uppercase text-[11px] tracking-wide"
          >
            <Tag className="h-3 w-3 shrink-0 panel-compact-icon" />
            <span className="panel-compact-text">bSDD</span>
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1 bg-white dark:bg-black">
          <TabsContent value="properties" className="m-0 p-3 overflow-hidden">
            {/* Edit toolbar - only shown when edit mode is active */}
            {editMode && selectedEntity && !isNativeLazySelection && (
              <EditToolbar
                modelId={selectedEntity.modelId}
                entityId={selectedEntity.expressId}
                entityType={entityType}
                existingPsets={renderedMergedProperties.map(p => p.name)}
                existingQtos={renderedQuantities.map(q => q.name)}
                schemaVersion={activeDataStore?.schemaVersion}
              />
            )}
            {renderedMergedProperties.length === 0 && renderedClassifications.length === 0 && !renderedMaterialInfo && renderedDocuments.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-500 text-center py-8 font-mono">No property sets</p>
            ) : (
              <div className="space-y-3 w-full overflow-hidden">
                {/* Occurrence/Type Properties (based on whether entity itself is a type) */}
                {renderedOccurrenceProperties.length > 0 && (
                  <>
                    {(renderedIsTypeEntity || (renderedTypeProperties && renderedTypeProperties.psets.length > 0)) && (
                      <div className="flex items-center gap-2 px-1 pb-0.5 text-[11px] text-zinc-500 dark:text-zinc-400 uppercase tracking-wider font-semibold">
                        {renderedIsTypeEntity ? (
                          <>
                            <Building2 className="h-3 w-3 shrink-0 text-indigo-500" />
                            Type Properties:
                          </>
                        ) : 'Occurrence Properties:'}
                      </div>
                    )}
                    {renderedOccurrenceProperties.map((pset: PropertySet) => (
                      <PropertySetCard
                        key={`occ-${pset.name}`}
                        pset={pset}
                        modelId={selectedEntity?.modelId}
                        entityId={selectedEntity?.expressId}
                        enableEditing={editMode && !isNativeLazySelection}
                        isTypeProperty={renderedIsTypeEntity}
                        typeEditScope={renderedIsTypeEntity ? renderedTypeEditImpact ?? undefined : undefined}
                      />
                    ))}
                  </>
                )}

                {/* Inherited Type Properties */}
                {renderedInheritedTypeProperties.length > 0 && renderedTypeProperties && (
                  <>
                    {renderedOccurrenceProperties.length > 0 && (
                      <div className="border-t border-indigo-200 dark:border-indigo-800/50 pt-2 mt-2" />
                    )}
                    <div className="flex items-center gap-2 px-1 pb-0.5 text-[11px] text-indigo-600/70 dark:text-indigo-400/60 uppercase tracking-wider font-semibold">
                      <Building2 className="h-3 w-3 shrink-0" />
                      <span className="truncate">Type Properties ({renderedTypeProperties.typeName})</span>
                    </div>
                    {renderedInheritedTypeProperties.map((pset: PropertySet) => (
                      <PropertySetCard
                        key={`type-${pset.name}`}
                        pset={pset}
                        modelId={selectedEntity?.modelId}
                        entityId={renderedTypeProperties.typeId}
                        enableEditing={editMode && !isNativeLazySelection}
                        isTypeProperty
                        typeEditScope={renderedTypeEditImpact?.mode === 'inherited' ? renderedTypeEditImpact : undefined}
                      />
                    ))}
                  </>
                )}

                {/* Classifications */}
                {renderedClassifications.length > 0 && (
                  <>
                    {renderedMergedProperties.length > 0 && (
                      <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2 mt-2" />
                    )}
                    {renderedClassifications.map((classification, i) => (
                      <ClassificationCard key={`class-${i}`} classification={classification} />
                    ))}
                  </>
                )}

                {/* Materials */}
                {renderedMaterialInfo && (
                  <>
                    {(renderedMergedProperties.length > 0 || renderedClassifications.length > 0) && (
                      <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2 mt-2" />
                    )}
                    <MaterialCard material={renderedMaterialInfo} />
                  </>
                )}

                {/* Documents */}
                {renderedDocuments.length > 0 && (
                  <>
                    {(renderedMergedProperties.length > 0 || renderedClassifications.length > 0 || renderedMaterialInfo) && (
                      <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2 mt-2" />
                    )}
                    {renderedDocuments.map((doc, i) => (
                      <DocumentCard key={`doc-${i}`} document={doc} />
                    ))}
                  </>
                )}

                {/* Relationships */}
                {renderedEntityRelationships && (
                  <>
                    <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2 mt-2" />
                    <RelationshipsCard relationships={renderedEntityRelationships} />
                  </>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="quantities" className="m-0 p-3 overflow-hidden">
            {renderedQuantities.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-500 text-center py-8 font-mono">No quantities</p>
            ) : (
              <div className="space-y-3 w-full overflow-hidden">
                {renderedQuantities.map((qset: QuantitySet) => (
                  <QuantitySetCard key={qset.name} qset={qset} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="bsdd" className="m-0 p-3 overflow-hidden">
            {selectedEntity && (
              <BsddCard
                entityType={entityType}
                modelId={selectedEntity.modelId}
                entityId={selectedEntity.expressId}
                existingPsets={renderedMergedProperties.map(p => p.name)}
                existingProps={renderedExistingProps}
                existingQsets={renderedQuantities.map(q => q.name)}
                existingQuants={renderedExistingQuants}
                existingAttributes={renderedExistingAttributeNames}
              />
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}

/** Inline attribute editor — pen icon to enter edit mode, input + save/cancel */
function AttributeEditorField({
  modelId,
  entityId,
  attrName,
  currentValue,
}: {
  modelId: string;
  entityId: number;
  attrName: string;
  currentValue: string;
}) {
  const setAttribute = useViewerStore((s) => s.setAttribute);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentValue);
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) { node.focus(); node.select(); }
  }, []);

  const save = useCallback(() => {
    let normalizedModelId = modelId;
    if (modelId === 'legacy') normalizedModelId = '__legacy__';
    setAttribute(normalizedModelId, entityId, attrName, value, currentValue || undefined);
    bumpMutationVersion();
    setEditing(false);
  }, [modelId, entityId, attrName, value, currentValue, setAttribute, bumpMutationVersion]);

  const cancel = useCallback(() => {
    setValue(currentValue);
    setEditing(false);
  }, [currentValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }, [save, cancel]);

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-0">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={save}
          className="flex-1 min-w-0 h-6 px-1.5 text-sm font-mono bg-white dark:bg-zinc-900 border border-purple-300 dark:border-purple-700 outline-none focus:ring-1 focus:ring-purple-400"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 p-0 shrink-0 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
          onClick={save}
        >
          <Check className="h-3 w-3 text-emerald-500" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 min-w-0 group/attr">
      <span
        className="font-medium whitespace-nowrap truncate flex-1 min-w-0 cursor-text"
        title={currentValue}
        onClick={() => setEditing(true)}
      >
        {currentValue || <span className="text-zinc-400 italic">empty</span>}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 p-0 shrink-0 opacity-0 group-hover/attr:opacity-100 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-opacity"
            onClick={() => setEditing(true)}
          >
            <PenLine className="h-3 w-3 text-purple-500" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Edit attribute</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Multi-entity panel for unified storeys - shows data from multiple entities stacked */
function MultiEntityPanel({
  entities,
  models,
  ifcDataStore,
}: {
  entities: EntityRef[];
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null;
}) {
  return (
    <div className="h-full flex flex-col border-l-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      {/* Header */}
      <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-emerald-600" />
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">
            Unified Storey
          </h2>
          <span className="text-[10px] font-mono bg-emerald-100 dark:bg-emerald-900 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            {entities.length} models
          </span>
        </div>
      </div>

      {/* Scrollable content with each entity's data */}
      <ScrollArea className="flex-1">
        <div className="divide-y-2 divide-zinc-200 dark:divide-zinc-800">
          {entities.map((entityRef, index) => (
            <EntityDataSection
              key={`${entityRef.modelId}-${entityRef.expressId}`}
              entityRef={entityRef}
              models={models}
              ifcDataStore={ifcDataStore}
              showModelName={true}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Renders data for a single entity (used in multi-entity panel) */
function EntityDataSection({
  entityRef,
  models,
  ifcDataStore,
  showModelName,
}: {
  entityRef: EntityRef;
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null;
  showModelName: boolean;
}) {
  // Get the appropriate data store and query
  const { dataStore, model } = useMemo(() => {
    if (entityRef.modelId !== 'legacy') {
      const m = models.get(entityRef.modelId);
      if (m) {
        return { dataStore: m.ifcDataStore, model: m };
      }
    }
    return { dataStore: ifcDataStore, model: null };
  }, [entityRef.modelId, models, ifcDataStore]);

  const query = useMemo(() => {
    return dataStore ? new IfcQuery(dataStore) : null;
  }, [dataStore]);

  const entityNode = useMemo(() => {
    if (!query) return null;
    return query.entity(entityRef.expressId);
  }, [query, entityRef.expressId]);

  // Get properties and quantities
  const properties: PropertySet[] = useMemo(() => {
    if (!entityNode) return [];
    const rawProps = entityNode.properties();
    return rawProps.map(pset => ({
      name: pset.name,
      properties: pset.properties.map(p => ({ name: p.name, value: p.value })),
    }));
  }, [entityNode]);

  const quantities: QuantitySet[] = useMemo(() => {
    if (!entityNode) return [];
    return entityNode.quantities();
  }, [entityNode]);

  // Get attributes - uses schema-aware extraction to show ALL string/enum attributes
  // Note: GlobalId is intentionally excluded since it's shown in the dedicated GUID field above
  const attributes = useMemo(() => {
    if (!entityNode) return [];
    return entityNode.allAttributes();
  }, [entityNode]);

  // Get elevation info
  const elevationInfo = useMemo(() => {
    if (!dataStore?.spatialHierarchy) return null;
    const elevation = dataStore.spatialHierarchy.storeyElevations.get(entityRef.expressId);
    return elevation !== undefined ? elevation : null;
  }, [dataStore, entityRef.expressId]);

  if (!entityNode) {
    return (
      <div className="p-4 text-center text-zinc-500 text-sm">
        Unable to load entity data
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-black">
      {/* Entity Header with model name */}
      <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 space-y-2">
        {showModelName && model && (
          <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            <FileBox className="h-3 w-3" />
            <span className="font-mono truncate">{model.name}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-emerald-600" />
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-sm truncate text-zinc-900 dark:text-zinc-100">
              {entityNode.name || `${entityNode.type} #${entityRef.expressId}`}
            </h3>
            <p className="text-xs font-mono text-zinc-500">{entityNode.type}</p>
          </div>
          {elevationInfo !== null && (
            <span className="text-[10px] font-mono bg-emerald-100 dark:bg-emerald-950 px-1.5 py-0.5 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
              {elevationInfo >= 0 ? '+' : ''}{elevationInfo.toFixed(2)}m
            </span>
          )}
        </div>
      </div>

      {/* Attributes */}
      {attributes.length > 0 && (
        <Collapsible defaultOpen className="border-b border-zinc-200 dark:border-zinc-800">
          <CollapsibleTrigger className="flex items-center gap-2 w-full p-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left text-xs">
            <Tag className="h-3 w-3 text-zinc-400" />
            <span className="font-medium">Attributes</span>
            <span className="text-[10px] text-zinc-400 ml-auto">{attributes.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900 border-t border-zinc-100 dark:border-zinc-900">
              {attributes.map((attr) => (
                <div key={attr.name} className="grid grid-cols-[minmax(60px,1fr)_minmax(0,2fr)] gap-2 px-3 py-1.5 text-xs">
                  <span className="text-zinc-500 truncate" title={attr.name}>{attr.name}</span>
                  <div className="overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 min-w-0">
                    <span className="font-medium whitespace-nowrap">{attr.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Properties */}
      {properties.length > 0 && (
        <Collapsible defaultOpen className="border-b border-zinc-200 dark:border-zinc-800">
          <CollapsibleTrigger className="flex items-center gap-2 w-full p-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left text-xs">
            <FileText className="h-3 w-3 text-zinc-400" />
            <span className="font-medium">Properties</span>
            <span className="text-[10px] text-zinc-400 ml-auto">{properties.length} sets</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="p-2 pt-0 space-y-2">
              {properties.map((pset) => (
                <PropertySetCard key={pset.name} pset={pset} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Quantities */}
      {quantities.length > 0 && (
        <Collapsible defaultOpen className="border-b border-zinc-200 dark:border-zinc-800">
          <CollapsibleTrigger className="flex items-center gap-2 w-full p-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left text-xs">
            <Calculator className="h-3 w-3 text-zinc-400" />
            <span className="font-medium">Quantities</span>
            <span className="text-[10px] text-zinc-400 ml-auto">{quantities.length} sets</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="p-2 pt-0 space-y-2">
              {quantities.map((qset) => (
                <QuantitySetCard key={qset.name} qset={qset} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
