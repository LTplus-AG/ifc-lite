// SPDX-License-Identifier: MPL-2.0
import type { MethodSchema } from './bridge-schema.js';

const REF = '{ modelId: string; expressId: number }';
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
function objectIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || !value.every(positive)) throw new Error('Expected a non-empty list of positive entity ids');
  return value;
}

/** Preserve the real SDK operations and their validation in viewer scripts. */
export function buildStoreMirrorClassificationMethods(): MethodSchema[] {
  return [
    {
      name: 'mirrorElements',
      doc: 'Mirror upright products about a storey-local XY axis, in place or as copies. Hosted cuts remain hosted; door handedness flips. Grids are refused atomically.',
      args: ['string', 'dump', 'dump'], paramNames: ['modelId', 'ids', 'params'],
      tsParamTypes: ['string', 'readonly number[]', 'BimCreate.MirrorElementsParams'],
      tsReturn: `${REF}[]`, returns: 'value',
      call: (sdk, args) => sdk.store.mirrorElements(args[0] as string, objectIds(args[1]), args[2] as Parameters<typeof sdk.store.mirrorElements>[2]),
    },
    {
      name: 'addClassification',
      doc: 'Create or reuse an IfcClassification of the same name and edition, plus its reference; optionally associate objects.',
      args: ['string', 'dump'], paramNames: ['modelId', 'params'],
      tsParamTypes: ['string', 'BimCreate.ClassificationInStoreParams'], tsReturn: REF, returns: 'value',
      call: (sdk, args) => sdk.store.addClassification(args[0] as string, args[1] as Parameters<typeof sdk.store.addClassification>[1]),
    },
    {
      name: 'assignClassification',
      doc: 'Associate objects with an existing IfcClassification or IfcClassificationReference, preserving other classifications.',
      args: ['string', 'number', 'dump'], paramNames: ['modelId', 'classificationId', 'objects'],
      tsParamTypes: ['string', 'number', 'readonly number[]'], tsReturn: REF, returns: 'value',
      call: (sdk, args) => {
        if (!positive(args[1])) throw new Error('Expected a positive classification id');
        return sdk.store.assignClassification(args[0] as string, args[1], objectIds(args[2]));
      },
    },
  ];
}
