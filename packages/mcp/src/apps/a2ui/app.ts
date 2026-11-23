/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BASIC_FUNCTIONS, MessageProcessor, NodeResolver, effect, getValue, isComponentNode,
  type ComponentApi, type FunctionImplementation,
} from '@a2ui/web_core/v1_0';
import { A2UI_MIME_TYPE } from '@ifc-lite/a2ui';
import { createIfcCatalog, IFC_CATALOG_COMPONENT_APIS, IFC_CATALOG_FUNCTION_APIS } from '@ifc-lite/a2ui/catalog';
import type { CallToolResult } from '../../protocol/types.js';
import { renderBasic } from './basic-components.js';
import { SURFACE_ACTIONS } from './constants.js';
import { element, refs, text, VIEWER_NOTE, type Props, type RendererAction } from './dom.js';
import { connectHost } from './host.js';
import { ifcComponents } from './ifc-components.js';

type DomComponent = ComponentApi & {
  render(props: Props, child: (node: unknown) => Node): HTMLElement;
};

const root = document.querySelector('main')!;
const status = document.getElementById('status')!;
const report = (message: string) => { status.textContent = message; };
const act: RendererAction = (action, targets, color) => { void callViewer(action, targets, color); };

const components: DomComponent[] = IFC_CATALOG_COMPONENT_APIS.map((api) => ({
  ...api,
  render: (props, child) => ifcComponents[api.name]
    ? ifcComponents[api.name](props, act)
    : renderBasic(api.name, props, child, report),
}));
const functions: FunctionImplementation[] = IFC_CATALOG_FUNCTION_APIS.map((api) => {
  const basic = BASIC_FUNCTIONS.find((fn) => fn.name === api.name);
  if (basic) return basic;
  return {
    ...api,
    execute(args, context) {
      if (!context.isUserActivated) return undefined;
      const action = SURFACE_ACTIONS.find((name) => name === api.name);
      if (!action || (args.query && args.refs === undefined)) {
        report(VIEWER_NOTE);
        return undefined;
      }
      return callViewer(action, refs(args.refs), text(args.color) || undefined);
    },
  };
});
const catalog = createIfcCatalog({ components, functions });
let dispose: (() => void) | undefined;

function render(result: CallToolResult): void {
  const payloads = result.content.flatMap((block) => block.type === 'resource' && block.resource?.mimeType === A2UI_MIME_TYPE
    && typeof block.resource.text === 'string' ? [block.resource.text] : []);
  if (!payloads.length) {
    root.replaceChildren(element('p', result.content.find((block) => block.type === 'text')?.text || 'No IFC surface was returned.'));
    return;
  }
  dispose?.();
  dispose = undefined;
  const processor = new MessageProcessor([catalog]);
  try {
    for (const payload of payloads) {
      const errors = processor.processMessagesWithErrors(JSON.parse(payload));
      if (errors.length) throw new Error('The host returned an invalid IFC surface.');
    }
    const resolvers = [...processor.model.surfacesMap.values()].map((surface) => new NodeResolver(surface, catalog));
    const renderChild = (child: unknown): Node => {
      if (!isComponentNode(child) || child.isPlaceholder) return document.createTextNode('');
      const implementation = components.find((component) => component.name === child.type);
      return implementation?.render(getValue(child.props), renderChild) ?? document.createTextNode('');
    };
    const stop = effect(() => {
      root.replaceChildren(...resolvers.map((resolver) => renderChild(getValue(resolver.rootNode))));
    });
    dispose = () => {
      stop();
      for (const resolver of resolvers) resolver.dispose();
      processor.dispose();
    };
    report('');
  } catch (err) {
    processor.dispose();
    root.replaceChildren(element('p', 'Could not render the IFC result.'));
    report(err instanceof Error ? err.message : String(err));
  }
}
const callViewer = connectHost(render, report);
