// SPDX-License-Identifier: MPL-2.0
import { IfcAPI } from '@ifc-lite/wasm';
import type { RetainedEngine } from '@ifc-lite/wasm/retained';
// #7955: actual external consumer compilation. An exposed development export
// makes these expected errors unused and fails the installed-package gate.
// @ts-expect-error Development binding is absent from the shipped module.
import { inspectDevelopmentSource } from '@ifc-lite/wasm';
// @ts-expect-error There is no published development subpath.
import '@ifc-lite/wasm/development-inspection';
declare const api: IfcAPI;
declare const retained: RetainedEngine;
// @ts-expect-error No speculative source-inspection member on IfcAPI.
api.inspectDevelopmentSource(new Uint8Array(), 10, '{}');
// @ts-expect-error RetainedEngine's reachable module must also exclude it.
retained.inspectDevelopmentSource(new Uint8Array(), 10, '{}');
// @ts-expect-error The existing retained IfcAPI gets no new member either.
new retained.IfcAPI().inspectDevelopmentSource(new Uint8Array(), 10, '{}');
void inspectDevelopmentSource;
