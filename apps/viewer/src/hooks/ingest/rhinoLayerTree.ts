/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tree a `.3dm` shows in the hierarchy panel: Rhino's layers as spatial
 * containers, so the panel reads a `.3dm` through the same
 * `store.spatialHierarchy` it reads an IFC or an IFCX model through, and the
 * storey tools work on a re-imported model (decision D3,
 * docs/architecture/rhino-3dm-import.md).
 *
 * Two shapes, one rule for each:
 *
 * - **Stamped**: some layer carries the exporter's spatial stamp
 *   (`IFC::GlobalId` + `IFC::Class`, plus `IFC::Elevation` on a storey). Those
 *   layers become the spatial structure they name, with the GlobalId the
 *   source IFC gave them, and every other layer is transparent: an object
 *   rolls up to the nearest stamped layer above it. A file ifc-lite exported
 *   therefore comes back as project / site / building / storey, the tree the
 *   source IFC shows, rather than as the export's class sublayers.
 * - **Layers**: no stamp anywhere. Every layer becomes an `IfcSpatialZone`
 *   under a root that stands for the file, and an object sits under its own
 *   layer. `IfcSpatialZone` is IFC's class for a named decomposition that is
 *   not a storey, which is what a Rhino layer is; it also keeps the layers out
 *   of the storey tools, and a foreign `.3dm` has no storeys for them.
 *
 * This is the one module besides `loadFile` and the adapter that knows Rhino
 * exists. It hands back plain data: the rows the adapter puts in the entity
 * table and the containment it writes into the relationship graph. The
 * hierarchy itself is the shared `SpatialHierarchyBuilder`'s, built from those
 * two tables, so a `.3dm` cannot drift from the IFC path.
 */

import { isSpatialStructureTypeName } from '@ifc-lite/data';
import type { RhinoImport } from '@ifc-lite/rhino3dm';

/** One spatial container: a Rhino layer, or the root that stands for the file. */
export interface RhinoContainer {
  expressId: number;
  /**
   * True when the container IS one of the file's objects, not a row of its
   * own: the export puts a spatial element that has geometry on a class
   * sublayer of its own layer, so the stamped layer and that object are the
   * same IFC entity (FZK's site carries the terrain). The entity row stands
   * for both, so its identity, class, name and geometry are kept and nothing
   * appears twice.
   */
  fromEntity: boolean;
  /** The class the stamp names, or `IfcSpatialZone` for a plain layer. */
  ifcClass: string;
  /** The stamped GlobalId, or `''` when the layer states none. */
  globalId: string;
  name: string;
  /** `IFC::Elevation` in metres, or null when the layer states none. */
  elevation: number | null;
  /** The containing container's express id; null for the root. */
  parent: number | null;
  /** The layer is off in Rhino, itself or through an ancestor. */
  hidden: boolean;
}

export interface RhinoTreePlan {
  /** The root first, then one per layer that became a container. */
  containers: RhinoContainer[];
  /**
   * The container each entity is contained in, by entity index; null when the
   * entity is itself a container, which its parent aggregates instead.
   */
  containerOfEntity: (number | null)[];
  /** The root container's express id: the `IfcProject` every hierarchy needs. */
  root: number;
  /** The first id no entity and no container holds. */
  firstFreeExpressId: number;
}

/** A plain layer: IFC's class for a named decomposition that is not a storey. */
const LAYER_CLASS = 'IfcSpatialZone';

/**
 * Plan the containers for one `.3dm`.
 *
 * `entityExpressId` is the adapter's id rule, which owns it: a container the
 * file does not already hold as an object takes the next id after the last
 * entity, because a container is an entity of this store too and
 * `getMaxExpressId` and the federation offset have to cover it. `fileName`
 * labels a synthesised root, which stands for the file itself; a `.3dm`
 * states no project name.
 */
export function planRhinoTree(
  result: RhinoImport,
  entityExpressId: (entityIndex: number) => number,
  fileName: string,
): RhinoTreePlan {
  const layers = result.layers;
  // Layers come parent first (a reader guarantee), so one forward pass answers
  // every ancestor question without a walk per layer.
  const off: boolean[] = [];
  layers.forEach((layer, index) => {
    off[index] = !layer.visible || (layer.parent !== null && off[layer.parent]);
  });

  /**
   * The layer's stamp, when the tree can place it. The reader accepts
   * `IfcProject` or any instantiable spatial element, a wider set than the
   * tree's own spatial types (`IfcExternalSpatialElement` is one of the
   * extras); a class outside it would be read as an element rather than a
   * node and the layer's objects would be orphaned, so the stamp is ignored
   * and the layer stays transparent like an unstamped one. The class the
   * reader hands over is already the schema's own spelling.
   */
  const stampOf = (index: number) => {
    const spatial = layers[index].spatial;
    return spatial && isSpatialStructureTypeName(spatial.ifcClass) ? spatial : null;
  };
  // Whether some layer above this one carries a placeable stamp, in the same
  // parent-first pass: a layer under one is part of a stamped structure, a
  // layer outside every stamped structure is a layer of the user's own.
  const underStamp: boolean[] = [];
  let stamped = false;
  layers.forEach((layer, index) => {
    stamped ||= stampOf(index) !== null;
    underStamp[index] = layer.parent !== null && (stampOf(layer.parent) !== null || underStamp[layer.parent]);
  });

  // Ids run in entity order, so the one past the last entity is the first free.
  let nextExpressId = entityExpressId(result.entities.length);
  // Only the stamped identities are looked up, so only those are indexed: a
  // map of every object's GlobalId would be built and thrown away for every
  // file without stamps, which is every file Rhino wrote.
  const stampedGlobalIds = new Set(layers.flatMap((_, index) => {
    const spatial = stampOf(index);
    return spatial ? [spatial.globalId] : [];
  }));
  const entityOfGlobalId = new Map<string, number>();
  if (stampedGlobalIds.size > 0) {
    result.entities.forEach((entity, index) => {
      if (stampedGlobalIds.has(entity.globalId)) entityOfGlobalId.set(entity.globalId, index);
    });
  }
  // Whether a layer, or anything under it, holds an object. Children come
  // after parents, so one backward pass carries it up. A layer that holds
  // nothing anywhere gets no row: an empty row is one the user cannot act on,
  // and the export leaves such layers behind (`IFC block geometry` holds the
  // block definitions, whose members are not entities of their own).
  const occupied: boolean[] = layers.map(() => false);
  for (const entity of result.entities) {
    if (entity.layer >= 0 && entity.layer < layers.length) occupied[entity.layer] = true;
  }
  for (let index = layers.length - 1; index >= 0; index--) {
    const parent = layers[index].parent;
    if (parent !== null && occupied[index]) occupied[parent] = true;
  }

  const containers: RhinoContainer[] = [];
  /** Identities already standing for a container, so no two rows share one. */
  const claimed = new Set<string>();
  /** Entity indices that are containers, so they are not also contained. */
  const containerEntities = new Set<number>();

  /** The container for a stamped layer: the object that already is it, or a new row. */
  const addStamped = (index: number, parent: number | null): number => {
    const spatial = stampOf(index)!;
    claimed.add(spatial.globalId);
    // An object stands for the layer only when it IS that layer's entity:
    // same identity AND same class. A file that puts a spatial GlobalId on an
    // object of another class would otherwise replace the node with that
    // object, and for an `IfcProject` stamp that leaves the store with no
    // `IfcProject` row at all, which is a hierarchy the builder refuses to
    // build. The node stays, and the identity stays with the object.
    const entity = entityOfGlobalId.get(spatial.globalId);
    if (entity !== undefined && result.entities[entity].ifcClass === spatial.ifcClass) {
      const expressId = entityExpressId(entity);
      containerEntities.add(entity);
      containers.push({
        expressId, fromEntity: true,
        ifcClass: result.entities[entity].ifcClass, globalId: spatial.globalId,
        name: result.entities[entity].name, elevation: spatial.elevation, parent,
        // The entity carries its own hidden flag, which the reader already
        // folded its layer path into.
        hidden: false,
      });
      return expressId;
    }
    containers.push({
      expressId: nextExpressId, fromEntity: false, ifcClass: spatial.ifcClass,
      globalId: entity === undefined ? spatial.globalId : '',
      name: layers[index].name, elevation: spatial.elevation, parent, hidden: off[index],
    });
    return nextExpressId++;
  };

  /** The root that stands for the file, when no stamped layer is the project. */
  const addFileRoot = (): number => {
    containers.push({
      expressId: nextExpressId, fromEntity: false, ifcClass: 'IfcProject',
      globalId: '', name: fileName, elevation: null, parent: null, hidden: false,
    });
    return nextExpressId++;
  };

  /** The container for a layer that carries no stamp. */
  const addLayerZone = (index: number, parent: number): number => {
    containers.push({
      expressId: nextExpressId, fromEntity: false, ifcClass: LAYER_CLASS,
      globalId: '', name: layers[index].name, elevation: null, parent, hidden: off[index],
    });
    return nextExpressId++;
  };

  // The root. A stamped `IfcProject` layer with no stamped layer above it IS
  // the project, with the GlobalId the source IFC gave it; anything else gets
  // a root standing for the file. Exactly one `IfcProject` node exists either
  // way: the hierarchy builder recurses from it and places no second one.
  const rootLayer = stamped
    ? layers.findIndex((_, index) => stampOf(index)?.ifcClass === 'IfcProject' && !underStamp[index])
    : -1;
  const root = rootLayer >= 0 ? addStamped(rootLayer, null) : addFileRoot();

  // The container each layer's objects belong to, filled parent first.
  const containerOfLayer: number[] = [];
  layers.forEach((layer, index) => {
    const parent = layer.parent === null ? root : containerOfLayer[layer.parent];
    const spatial = stampOf(index);
    // The one project node is already the root. A second `IfcProject` stamp
    // and a stamp whose identity another container took are transparent, as
    // is a layer with no stamp.
    const transparent = spatial === null || spatial.ifcClass === 'IfcProject' || claimed.has(spatial.globalId);
    if (index === rootLayer) containerOfLayer[index] = root;
    // A transparent layer inside a stamped structure rolls up to it: that is
    // what turns the export's class sublayers back into the IFC's tree. One
    // outside every stamped structure is a layer of the user's own (a
    // Rhino-authored file is all of them, and so is a layer somebody added to
    // an export) and keeps its own zone.
    else if (transparent) {
      containerOfLayer[index] = underStamp[index] || !occupied[index] ? parent : addLayerZone(index, parent);
    }
    else containerOfLayer[index] = addStamped(index, parent);
  });

  const containerOfEntity = result.entities.map((entity, index) =>
    // An object whose layer index is outside the table lands on the first
    // layer (the reader's rule), so every entity has a container; a file with
    // no layer at all puts them on the root.
    containerEntities.has(index) ? null : containerOfLayer[entity.layer] ?? root);
  return { containers, containerOfEntity, root, firstFreeExpressId: nextExpressId };
}
