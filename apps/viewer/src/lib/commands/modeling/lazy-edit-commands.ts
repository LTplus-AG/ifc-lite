// SPDX-License-Identifier: MPL-2.0
import { getModelingCommand, registerModelingCommand } from './registry';

/** Keep Mirror/Offset's SDK and HUD graph out of startup. Retry failed loads. */
export function isLazyEditCommand(id: string): boolean {
  return id === 'element.mirror' || id === 'element.offset';
}
export async function loadEditCommand(id: string): Promise<void> {
  if (getModelingCommand(id)) return;
  if (id === 'element.mirror') {
    const { ELEMENT_MIRROR } = await import('./commands/element-mirror');
    if (!getModelingCommand(id)) registerModelingCommand(ELEMENT_MIRROR);
  } else if (id === 'element.offset') {
    const { ELEMENT_OFFSET } = await import('./commands/element-offset');
    if (!getModelingCommand(id)) registerModelingCommand(ELEMENT_OFFSET);
  }
}
