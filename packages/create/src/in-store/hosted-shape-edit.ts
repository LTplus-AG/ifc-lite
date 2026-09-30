/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Occurrence-only affine size edit. Source/type geometry and styles remain
 * shared and immutable; each representation receives its own mapping wrapper.
 * IFC mapping supports independent axis scales, including nested mappings:
 * https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcCartesianTransformationOperator3DnonUniform.htm */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { AnchorEntityReader } from './resolve-anchor.js';
import { applyFrame, contextDimension, inverseFrame, refId, type Frame3, type Vec3 } from './host-geometry-frame.js';
import { retainedHostedScale } from './hosted-scale-chain.js';

const ref = (id: number) => `#${id}`;

export function scaleHostedShape(
  reader: AnchorEntityReader, editor: StoreEditor, productId: number,
  inHost: Frame3, hostAnchor: Vec3, widthScale: number, heightScale: number,
): void {
  const product = reader.entity(productId);
  const shapeId = product ? refId(product.attributes[6]) : null;
  const shape = shapeId === null ? null : reader.entity(shapeId);
  if (shape?.type.toUpperCase() !== 'IFCPRODUCTDEFINITIONSHAPE' || !Array.isArray(shape.attributes[2])) {
    throw new Error(`Representation of #${productId} cannot be resized without losing its geometry`);
  }
  const inverse = inverseFrame(inHost);
  const localAnchor = applyFrame(inverse, hostAnchor);
  // The renderer/IfcOpenShell compose MappingTarget * MappingOrigin. The
  // source frame therefore maps product coordinates into host coordinates
  // relative to the held anchor; the target maps scaled host axes back into
  // the product. Together this is P^-1 * anchoredScale * P, not its inverse.
  const sourceAnchor = inHost.o.map((value, axis) => value - hostAnchor[axis]) as Vec3;
  const sourcePoint3 = editor.addEntity('IfcCartesianPoint', [sourceAnchor]).expressId;
  const sourceX = editor.addEntity('IfcDirection', [inHost.x]).expressId;
  const sourceZ = editor.addEntity('IfcDirection', [inHost.z]).expressId;
  const point3 = editor.addEntity('IfcCartesianPoint', [localAnchor]).expressId;
  const directions = [inverse.x, inverse.y, inverse.z].map(v => editor.addEntity('IfcDirection', [v]).expressId);
  const origin3 = editor.addEntity('IfcAxis2Placement3D', [ref(sourcePoint3), ref(sourceZ), ref(sourceX)]).expressId;
  const representations: string[] = [];
  if (shape.attributes[2].length === 0 || shape.attributes[2].length > 10_000) throw new Error('The representation list cannot be resized safely');
  for (const value of shape.attributes[2]) {
    const repId = refId(value), rep = repId === null ? null : reader.entity(repId);
    const contextId = rep ? refId(rep.attributes[0]) : null;
    const dimension = contextId === null ? null : contextDimension(reader, contextId);
    if (rep?.type.toUpperCase() !== 'IFCSHAPEREPRESENTATION' || repId === null || contextId === null || dimension === null) {
      throw new Error(`A representation of #${productId} cannot be resized without losing its geometry`);
    }
    const retained = retainedHostedScale(reader, repId, dimension, inHost, sourceAnchor, inverse, localAnchor);
    const width = widthScale * (retained?.width ?? 1);
    const height = heightScale * (retained?.height ?? 1);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The cumulative representation scale is invalid');
    let origin = origin3, target: number;
    if (dimension === 2) {
      // A plan representation lives in local XY. Tilting it into another
      // plane cannot be represented by a 2D operator; refuse instead.
      if (Math.abs(inverse.z[0]) > 1e-9 || Math.abs(inverse.z[1]) > 1e-9 || Math.abs(inverse.z[2] - 1) > 1e-9) {
        throw new Error(`The plan representation of #${productId} has an unsupported tilted frame`);
      }
      const sourcePoint = editor.addEntity('IfcCartesianPoint', [[sourceAnchor[0], sourceAnchor[1]]]).expressId;
      const sourceDirection = editor.addEntity('IfcDirection', [[inHost.x[0], inHost.x[1]]]).expressId;
      const point = editor.addEntity('IfcCartesianPoint', [[localAnchor[0], localAnchor[1]]]).expressId;
      const x = editor.addEntity('IfcDirection', [[inverse.x[0], inverse.x[1]]]).expressId;
      const y = editor.addEntity('IfcDirection', [[inverse.y[0], inverse.y[1]]]).expressId;
      origin = editor.addEntity('IfcAxis2Placement2D', [ref(sourcePoint), ref(sourceDirection)]).expressId;
      target = editor.addEntity('IfcCartesianTransformationOperator2DnonUniform', [ref(x), ref(y), ref(point), width, 1]).expressId;
    } else {
      target = editor.addEntity('IfcCartesianTransformationOperator3DnonUniform', [
        ref(directions[0]), ref(directions[1]), ref(point3), width, ref(directions[2]), 1, height,
      ]).expressId;
    }
    const map = editor.addEntity('IfcRepresentationMap', [ref(origin), ref(retained?.repId ?? repId)]).expressId;
    const item = editor.addEntity('IfcMappedItem', [ref(map), ref(target)]).expressId;
    const identifier = rep.attributes[1] ?? null;
    if (identifier !== null && typeof identifier !== 'string') throw new Error('An unreadable representation identifier is refused');
    representations.push(ref(editor.addEntity('IfcShapeRepresentation', [ref(contextId), identifier, 'MappedRepresentation', [ref(item)]]).expressId));
  }
  const label = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('An unreadable product shape label is refused');
    return value;
  };
  const nextShape = editor.addEntity('IfcProductDefinitionShape', [label(shape.attributes[0]), label(shape.attributes[1]), representations]).expressId;
  editor.setPositionalAttribute(productId, 6, ref(nextShape));
}
