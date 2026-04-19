/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests that concrete IFC entity subtypes are recognized correctly.
 *
 * Regression test for: IfcAirTerminal and other MEP subtypes being silently
 * skipped (CAT_SKIP) because getCategory() only matched exact names in
 * GEOMETRY_TYPES, without walking the inheritance chain.
 */

import { describe, it, expect } from 'vitest';
import { getInheritanceChain } from '../src/ifc-schema.js';

describe('IFC entity inheritance chain', () => {
    it('IfcAirTerminal has IfcFlowTerminal in its inheritance chain', () => {
        const chain = getInheritanceChain('IfcAirTerminal');
        expect(chain.map(c => c.toUpperCase())).toContain('IFCFLOWTERMINAL');
    });

    it('IfcPump has IfcFlowMovingDevice in its inheritance chain', () => {
        const chain = getInheritanceChain('IfcPump');
        expect(chain.map(c => c.toUpperCase())).toContain('IFCFLOWMOVINGDEVICE');
    });

    it('IfcDuctSegment has IfcFlowSegment in its inheritance chain', () => {
        const chain = getInheritanceChain('IfcDuctSegment');
        expect(chain.map(c => c.toUpperCase())).toContain('IFCFLOWSEGMENT');
    });

    it('IfcValve has IfcFlowController in its inheritance chain', () => {
        const chain = getInheritanceChain('IfcValve');
        expect(chain.map(c => c.toUpperCase())).toContain('IFCFLOWCONTROLLER');
    });

    it('IfcWall still resolves (direct match should still work)', () => {
        const chain = getInheritanceChain('IfcWall');
        expect(chain.map(c => c.toUpperCase())).toContain('IFCWALL');
    });

    it('accepts UPPERCASE input (as passed from getCategory)', () => {
        const chain = getInheritanceChain('IFCAIRTERMINAL');
        expect(chain.map(c => c.toUpperCase())).toContain('IFCFLOWTERMINAL');
    });
});
