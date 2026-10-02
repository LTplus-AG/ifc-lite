/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type { ProfileDefinition, ProfileField, ProfileType } from './profiles.js';
export interface SemanticResource { id: string; type: string; label: string; [key: string]: unknown }
export interface SemanticDocument { profile: string; source: string; completeness: 'complete' | 'partial'; resources: SemanticResource[] }
export interface ValidationFinding { engine: 'JSON Schema' | 'SHACL' | 'links'; resourceId: string; path: string; message: string; severity?: 'Violation' | 'Warning' | 'Info' }
