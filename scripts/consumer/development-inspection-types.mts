// SPDX-License-Identifier: MPL-2.0
import { inspectDevelopmentSource } from '@ifc-lite/development-inspection';
// Check the actual generated private declaration, without a public tsconfig alias.
const inspect: (data: Uint8Array, productId: number, options: string) => Uint8Array = inspectDevelopmentSource;
void inspect;
