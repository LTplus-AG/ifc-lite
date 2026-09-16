/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { EntityFlags } from '@ifc-lite/data';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { elementFieldColumnId } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { createElementFieldReader, type ElementFieldCatalog, type ElementFieldOption } from '@/lib/charts/element-field-reader';

export interface ElementFieldCatalogState {
  catalog: ElementFieldCatalog;
  loading: boolean;
}

const EMPTY: ElementFieldCatalog = { attributes: [], properties: new Map() };

function mergeOptions(target: Map<string, ElementFieldOption>, options: readonly ElementFieldOption[]): void {
  for (const option of options) {
    const id = elementFieldColumnId(option.binding);
    const previous = target.get(id);
    if (!previous) target.set(id, option);
    else if (previous.binding.valueKind !== option.binding.valueKind || previous.binding.dataType !== option.binding.dataType) {
      target.set(id, { ...option, binding: { ...option.binding, valueKind: 'category', unit: undefined } as ElementFieldBinding });
    }
  }
}

export function useElementFieldCatalog(enabled: boolean): ElementFieldCatalogState {
  const models = useViewerStore((s) => s.models);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [state, setState] = useState<ElementFieldCatalogState>({ catalog: EMPTY, loading: false });

  useEffect(() => {
    if (!enabled) {
      setState({ catalog: EMPTY, loading: false });
      return;
    }
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));
    const run = async (): Promise<void> => {
      const attrs = new Map<string, ElementFieldOption>();
      const props = new Map<string, ElementFieldOption>();
      for (const model of models.values()) {
        if (cancelled) return;
        const store = model.ifcDataStore;
        if (!store) continue;
        const ids: number[] = [];
        for (let i = 0; i < store.entities.count; i++) {
          if ((store.entities.flags[i] & EntityFlags.HAS_GEOMETRY) !== 0 && (store.entities.flags[i] & EntityFlags.IS_TYPE) === 0) ids.push(store.entities.expressId[i]);
        }
        const discovered = createElementFieldReader(store, mutationViews.get(model.id)).discover(ids);
        mergeOptions(attrs, discovered.attributes);
        for (const options of discovered.properties.values()) mergeOptions(props, options);
        // Yield between models so removal/reload can cancel publication.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (cancelled) return;
      const properties = new Map<string, ElementFieldOption[]>();
      for (const option of props.values()) {
        if (option.binding.kind !== 'property') continue;
        const bucket = properties.get(option.binding.psetName) ?? [];
        bucket.push(option);
        properties.set(option.binding.psetName, bucket);
      }
      for (const options of properties.values()) options.sort((a, b) => a.label.localeCompare(b.label));
      setState({
        loading: false,
        catalog: {
          attributes: [...attrs.values()].sort((a, b) => a.label.localeCompare(b.label)),
          properties: new Map([...properties].sort(([a], [b]) => a.localeCompare(b))),
        },
      });
    };
    void run().catch((error: unknown) => {
      if (!cancelled) {
        console.error('Failed to discover chart IFC fields', error);
        setState({ catalog: EMPTY, loading: false });
      }
    });
    return () => { cancelled = true; };
  }, [enabled, models, mutationViews, mutationVersion]);

  return state;
}
