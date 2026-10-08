// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';

/**
 * STEP export generates private Pset/Qto scaffolding above the current monotonic
 * allocator and gives its containers fresh GUIDs. Those identities do not live
 * in the source/overlay. Normalize only that scaffolding; persisted identities,
 * quantity classes, nominal values, names, units and reference topology remain.
 */
function metadataGraph(graph, persistentIds) {
  const synthetic = graph.filter(row => !persistentIds.has(row.id));
  const ids = new Map(synthetic.map((row, index) => [row.id, `export-metadata:${index}`]));
  const refs = value => Array.isArray(value) ? value.map(refs) : ids.get(value) ?? value;
  return graph.map(row => {
    if (!ids.has(row.id)) return row;
    const attributes = structuredClone(row.attributes), type = row.type.toUpperCase();
    if (type === 'IFCPROPERTYSET') { attributes[0] = '<generated-guid>'; attributes[4] = refs(attributes[4]); }
    else if (type === 'IFCELEMENTQUANTITY') { attributes[0] = '<generated-guid>'; attributes[5] = refs(attributes[5]); }
    else if (type === 'IFCRELDEFINESBYPROPERTIES') { attributes[0] = '<generated-guid>'; attributes[4] = refs(attributes[4]); attributes[5] = refs(attributes[5]); }
    else if (type === 'IFCPROPERTYSINGLEVALUE' || type === 'IFCPROPERTYLISTVALUE') attributes[3] = refs(attributes[3]);
    else if (/^IFCQUANTITY(LENGTH|AREA|VOLUME|COUNT|WEIGHT|TIME|NUMBER)$/.test(type)) attributes[2] = refs(attributes[2]);
    else throw new Error(`Unexpected nonpersistent export entity ${type} #${row.id}`);
    return { ...row, id: ids.get(row.id), attributes };
  });
}
module.exports = { metadataGraph };
