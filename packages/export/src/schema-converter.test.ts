/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import {
  convertEntityType,
  convertStepLine,
  needsConversion,
  describeConversion,
  type IfcSchemaVersion,
} from './schema-converter.js';

describe('schema-converter', () => {
  // ─── convertEntityType ──────────────────────────────────────────────────

  describe('convertEntityType', () => {
    it('returns same type when source and target schemas are identical', () => {
      expect(convertEntityType('IFCWALL', 'IFC4', 'IFC4')).toBe('IFCWALL');
      expect(convertEntityType('IFCDOOR', 'IFC2X3', 'IFC2X3')).toBe('IFCDOOR');
    });

    it('passes through types that exist in all schemas unchanged', () => {
      expect(convertEntityType('IFCWALL', 'IFC4', 'IFC4X3')).toBe('IFCWALL');
      expect(convertEntityType('IFCSLAB', 'IFC4', 'IFC2X3')).toBe('IFCSLAB');
      expect(convertEntityType('IFCBEAM', 'IFC2X3', 'IFC4')).toBe('IFCBEAM');
      expect(convertEntityType('IFCPROJECT', 'IFC4', 'IFC5')).toBe('IFCPROJECT');
    });

    it('converts IFC2X3-only types to IFC4 equivalents', () => {
      expect(convertEntityType('IFCELECTRICDISTRIBUTIONPOINT', 'IFC2X3', 'IFC4')).toBe('IFCELECTRICDISTRIBUTIONBOARD');
      expect(convertEntityType('IFCGASTERMINALTYPE', 'IFC2X3', 'IFC4')).toBe('IFCBURNERTYPE');
    });

    it('converts IFC4-only types to IFC2X3 fallbacks', () => {
      expect(convertEntityType('IFCCHIMNEY', 'IFC4', 'IFC2X3')).toBe('IFCBUILDINGELEMENTPROXY');
      expect(convertEntityType('IFCSHADINGDEVICE', 'IFC4', 'IFC2X3')).toBe('IFCBUILDINGELEMENTPROXY');
      expect(convertEntityType('IFCDEEPFOUNDATION', 'IFC4', 'IFC2X3')).toBe('IFCFOOTING');
    });

    it('converts IFC4X3 facility types to IFC4 equivalents', () => {
      expect(convertEntityType('IFCBRIDGE', 'IFC4X3', 'IFC4')).toBe('IFCBUILDING');
      expect(convertEntityType('IFCBRIDGEPART', 'IFC4X3', 'IFC4')).toBe('IFCBUILDINGSTOREY');
      expect(convertEntityType('IFCROAD', 'IFC4X3', 'IFC4')).toBe('IFCBUILDING');
      expect(convertEntityType('IFCRAILWAY', 'IFC4X3', 'IFC4')).toBe('IFCBUILDING');
      expect(convertEntityType('IFCMARINEFACILITY', 'IFC4X3', 'IFC4')).toBe('IFCBUILDING');
    });

    it('converts IFC4X3 facility types to IFC2X3 (multi-step)', () => {
      expect(convertEntityType('IFCBRIDGE', 'IFC4X3', 'IFC2X3')).toBe('IFCBUILDING');
      expect(convertEntityType('IFCBRIDGEPART', 'IFC4X3', 'IFC2X3')).toBe('IFCBUILDINGSTOREY');
      expect(convertEntityType('IFCPAVEMENT', 'IFC4X3', 'IFC2X3')).toBe('IFCSLAB');
    });

    it('treats IFC5 as aligned with IFC4X3 for entity names', () => {
      expect(convertEntityType('IFCWALL', 'IFC5', 'IFC4X3')).toBe('IFCWALL');
      expect(convertEntityType('IFCWALL', 'IFC4X3', 'IFC5')).toBe('IFCWALL');
    });

    it('converts IFC5 to IFC4 through IFC4X3 path', () => {
      expect(convertEntityType('IFCBRIDGE', 'IFC5', 'IFC4')).toBe('IFCBUILDING');
      expect(convertEntityType('IFCRAILWAY', 'IFC5', 'IFC4')).toBe('IFCBUILDING');
    });

    it('converts IFC4 to IFC5 through IFC4X3 path', () => {
      // IFC4 types are generally valid in IFC5 (IFC4X3-aligned)
      expect(convertEntityType('IFCWALL', 'IFC4', 'IFC5')).toBe('IFCWALL');
    });

    it('converts IFC5 to IFC2X3 (multi-step)', () => {
      expect(convertEntityType('IFCBRIDGE', 'IFC5', 'IFC2X3')).toBe('IFCBUILDING');
      expect(convertEntityType('IFCPAVEMENT', 'IFC5', 'IFC2X3')).toBe('IFCSLAB');
    });
  });

  // ─── convertStepLine ────────────────────────────────────────────────────

  describe('convertStepLine', () => {
    it('returns line unchanged when schemas are the same', () => {
      const line = "#1=IFCWALL('guid',$,'Wall',$,$,$,$,$,.NOTDEFINED.);";
      expect(convertStepLine(line, 'IFC4', 'IFC4')).toBe(line);
    });

    it('converts entity type name in STEP line', () => {
      const line = "#10=IFCBRIDGE('guid',$,'Bridge 1',$,$,$,$,$);";
      const result = convertStepLine(line, 'IFC4X3', 'IFC4');
      expect(result).toBe("#10=IFCBUILDING('guid',$,'Bridge 1',$,$,$,$,$);");
    });

    it('trims trailing attributes when converting to IFC2X3', () => {
      // IFC4 IfcWall has 9 attrs, IFC2X3 has 8 (no PredefinedType)
      const line = "#5=IFCWALL('guid',$,'Wall 1',$,$,$,$,'tag',.STANDARD.);";
      const result = convertStepLine(line, 'IFC4', 'IFC2X3');
      // Should not contain PredefinedType (.STANDARD.)
      expect(result).not.toContain('.STANDARD.');
      // Should still have 8 attrs
      expect(result).toContain('IFCWALL(');
    });

    it('replaces skipped entities with IFCPROXY placeholder to prevent dangling references', () => {
      const line = "#99=IFCALIGNMENTCANT('guid',$,$,$,$,$,$,$);";
      const result = convertStepLine(line, 'IFC4X3', 'IFC4');
      expect(result).toContain('#99=IFCPROXY(');
      expect(result).toContain('IFCALIGNMENTCANT');
      expect(result).toContain('.NOTDEFINED.');
      // The placeholder GlobalId must be spec-valid (128-bit, first char 0-3),
      // not a synthetic marker that fails isValidIfcGuid in downstream tools.
      const guid = result?.match(/IFCPROXY\('([^']{22})'/)?.[1];
      expect(guid).toBeDefined();
      expect(isValidIfcGuid(guid as string)).toBe(true);
    });

    it('preserves alignment entities when converting IFC4X3 → IFC5', () => {
      const line = "#99=IFCALIGNMENTCANT('guid',$,'Cant1',$,$,$,$,$);";
      const result = convertStepLine(line, 'IFC4X3', 'IFC5');
      // Should preserve the original entity, not proxy it
      expect(result).toContain('IFCALIGNMENTCANT(');
      expect(result).not.toContain('IFCPROXY');
    });

    it('preserves alignment entities when converting IFC4X3 → IFC4X3', () => {
      const line = "#50=IFCALIGNMENTHORIZONTAL('guid',$,'HAlign',$,$,$,$,$);";
      expect(convertStepLine(line, 'IFC4X3', 'IFC4X3')).toBe(line);
    });

    it('replaces alignment entities with proxy when converting to IFC2X3', () => {
      const line = "#99=IFCALIGNMENTVERTICAL('guid',$,$,$,$,$,$,$);";
      const result = convertStepLine(line, 'IFC4X3', 'IFC2X3');
      expect(result).toContain('#99=IFCPROXY(');
    });

    it('passes through non-entity lines unchanged', () => {
      expect(convertStepLine('/* comment */', 'IFC4', 'IFC2X3')).toBe('/* comment */');
      expect(convertStepLine('', 'IFC4', 'IFC2X3')).toBe('');
    });

    it('handles complex STEP attribute values correctly', () => {
      // Attributes with nested parentheses and strings
      const line = "#10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Basic Wall:Interior - 79mm Partition (1-hr):128475',$,'Basic Wall:Interior - 79mm Partition (1-hr)',$,#8,#9,.STANDARD.);";
      const result = convertStepLine(line, 'IFC4', 'IFC2X3');
      // Entity type stays IFCWALL
      expect(result).toContain('IFCWALL(');
      // Last attribute (.STANDARD.) should be trimmed for IFC2X3 (8 attrs max)
      expect(result).not.toContain('.STANDARD.');
    });

    it('converts IFC4X3-specific types and preserves attributes', () => {
      const line = "#20=IFCPAVEMENT('guid',$,'Sidewalk',$,$,$,$,'tag');";
      const result = convertStepLine(line, 'IFC4X3', 'IFC4');
      expect(result).toContain('IFCSLAB(');
      expect(result).toContain("'Sidewalk'");
    });

    it('handles IFC5 target schema', () => {
      const line = "#1=IFCWALL('guid',$,'Wall',$,$,$,$,$,.NOTDEFINED.);";
      const result = convertStepLine(line, 'IFC4', 'IFC5');
      expect(result).toContain('IFCWALL(');
    });

    it('handles strings with escaped single quotes', () => {
      const line = "#10=IFCWALL('guid',$,'Wall''s Name',$,$,$,$,'tag',.STANDARD.);";
      const result = convertStepLine(line, 'IFC4', 'IFC2X3');
      // Preserved escaped quote
      expect(result).toContain("'Wall''s Name'");
    });

    // ─── upconversion attribute padding (issue #1416) ──────────────────────

    it('pads PredefinedType when upconverting IFC2X3 → IFC4 (IfcOpeningElement 8→9)', () => {
      const line = "#5=IFCOPENINGELEMENT('guid',$,$,$,'Opening',#6,#7,$);"; // 8 attrs
      const result = convertStepLine(line, 'IFC2X3', 'IFC4');
      expect(result).toBe("#5=IFCOPENINGELEMENT('guid',$,$,$,'Opening',#6,#7,$,$);"); // 9
    });

    it('pads IfcWall 8→9 on IFC2X3 → IFC4', () => {
      const line = "#10=IFCWALL('guid',$,'W',$,$,#1,#2,'tag');"; // 8 attrs
      const result = convertStepLine(line, 'IFC2X3', 'IFC4');
      expect(result).toBe("#10=IFCWALL('guid',$,'W',$,$,#1,#2,'tag',$);"); // +PredefinedType
    });

    it('pads multiple added attributes (IfcMaterial 1→3)', () => {
      const result = convertStepLine("#3=IFCMATERIAL('Steel');", 'IFC2X3', 'IFC4');
      expect(result).toBe("#3=IFCMATERIAL('Steel',$,$);"); // +Description,+Category
    });

    it('tolerates whitespace after = (Tekla-style formatting)', () => {
      const line = "#34498= IFCOPENINGELEMENT('guid',$,$,$,'Opening',#6,#7,$);";
      const result = convertStepLine(line, 'IFC2X3', 'IFC4');
      // Reassembled without the stray space, and padded to 9 attrs.
      expect(result).toBe("#34498=IFCOPENINGELEMENT('guid',$,$,$,'Opening',#6,#7,$,$);");
    });

    it('does not pad when the attribute count already matches (IfcSlab 9=9)', () => {
      const line = "#11=IFCSLAB('guid',$,'S',$,$,#1,#2,'tag',.FLOOR.);"; // 9 attrs
      expect(convertStepLine(line, 'IFC2X3', 'IFC4')).toBe(line);
    });

    it('does NOT pad entities whose attrs were reordered, not appended (IfcMaterialProperties)', () => {
      // IFC2X3 [Material] vs IFC4 [Name, Description, Properties, Material] — NOT a
      // prefix, so trailing `$` would shove the Material ref into the Name slot.
      const line = '#5=IFCMATERIALPROPERTIES(#6);';
      expect(convertStepLine(line, 'IFC2X3', 'IFC4')).toBe(line); // left untouched
    });

    it('does NOT pad a reordered IfcApproval (7→9, fully reordered)', () => {
      const line = "#5=IFCAPPROVAL('desc','2020-01-01',$,$,$,'Name','Id');"; // 7 attrs
      expect(convertStepLine(line, 'IFC2X3', 'IFC4')).toBe(line);
    });
  });

  // ─── needsConversion ────────────────────────────────────────────────────

  describe('needsConversion', () => {
    it('returns false for same schema', () => {
      expect(needsConversion('IFC4', 'IFC4')).toBe(false);
      expect(needsConversion('IFC2X3', 'IFC2X3')).toBe(false);
      expect(needsConversion('IFC5', 'IFC5')).toBe(false);
    });

    it('returns true for different schemas', () => {
      expect(needsConversion('IFC4', 'IFC2X3')).toBe(true);
      expect(needsConversion('IFC2X3', 'IFC4')).toBe(true);
      expect(needsConversion('IFC4', 'IFC5')).toBe(true);
      expect(needsConversion('IFC4X3', 'IFC4')).toBe(true);
    });
  });

  // ─── describeConversion ─────────────────────────────────────────────────

  describe('describeConversion', () => {
    it('returns no conversion message for same schema', () => {
      expect(describeConversion('IFC4', 'IFC4')).toBe('No conversion needed');
    });

    it('warns about IFC2X3 attribute trimming', () => {
      const desc = describeConversion('IFC4', 'IFC2X3');
      expect(desc).toContain('IFC2X3');
      expect(desc).toContain('trimmed');
    });

    it('warns about IFC5 alpha status', () => {
      const desc = describeConversion('IFC4', 'IFC5');
      expect(desc).toContain('alpha');
    });

    it('warns about facility type mapping', () => {
      const desc = describeConversion('IFC4X3', 'IFC4');
      expect(desc).toContain('facility types');
    });
  });

  // ─── Round-trip stability ───────────────────────────────────────────────

  describe('round-trip', () => {
    it('preserves common types through IFC4 → IFC4X3 → IFC4', () => {
      const types = ['IFCWALL', 'IFCSLAB', 'IFCBEAM', 'IFCCOLUMN', 'IFCPROJECT'];
      for (const type of types) {
        const intermediate = convertEntityType(type, 'IFC4', 'IFC4X3');
        const roundTripped = convertEntityType(intermediate, 'IFC4X3', 'IFC4');
        expect(roundTripped).toBe(type);
      }
    });

    it('preserves common types through IFC4 → IFC5 → IFC4', () => {
      const types = ['IFCWALL', 'IFCDOOR', 'IFCWINDOW', 'IFCSITE', 'IFCBUILDING'];
      for (const type of types) {
        const intermediate = convertEntityType(type, 'IFC4', 'IFC5');
        const roundTripped = convertEntityType(intermediate, 'IFC5', 'IFC4');
        expect(roundTripped).toBe(type);
      }
    });
  });
});
