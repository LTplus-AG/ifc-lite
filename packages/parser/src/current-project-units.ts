/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntities } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { extractProjectUnits, ProjectUnits, ProjectUnitReadError, type UnitEntityReader } from './project-units.js';

export interface CurrentProjectUnitResult {
    status: 'available' | 'unavailable';
    reason: string | null;
    value: ProjectUnits | null;
}

/** Current native display context, using the same resolver as source-only reads (#7353). */
export function readCurrentProjectUnits(store: IfcDataStore, view: MetadataReadView, projectId?: number): CurrentProjectUnitResult {
    try {
        const projects: number[] = [];
        for (const row of iterateEffectiveEntities(store, view, ['IfcProject'])) {
            if (projects.length >= 256) throw new ProjectUnitReadError('Native project inventory exceeds the read limit');
            projects.push(row.expressId);
        }
        const selected = projectId ?? projects[0];
        if (selected === undefined) {
            // A source with no project keeps the canonical undeclared-unit convention.
            if (store.entityIndex.byType.get('IFCPROJECT')?.length) throw new ProjectUnitReadError('Native project unit context was deleted');
            return { status: 'available', reason: null, value: ProjectUnits.empty() };
        }
        if (!projects.includes(selected)) throw new ProjectUnitReadError('Native owning project is unavailable');
        const read: UnitEntityReader = id => {
            const record = effectiveMetadataRecord(store, id, view);
            if (!record) throw new ProjectUnitReadError('Native project unit dependency is unreadable');
            return record;
        };
        return { status: 'available', reason: null, value: extractProjectUnits(store.source, store.entityIndex, selected, read) };
    } catch (error) {
        if (error instanceof ProjectUnitReadError) return { status: 'unavailable', reason: error.message, value: null };
        console.warn('[project units] Native current unit context failed', error);
        return { status: 'unavailable', reason: 'Native current project units are unreadable', value: null };
    }
}
