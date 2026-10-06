/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider guidance for reviewed check authoring (#6915): the exact
 * `ids.specifications`, `rules.proposal` and `document.outline` contracts,
 * kept short so they fit beside the evidence. Validated by the strict parsers
 * in this folder; the user reviews, dry-runs and saves every draft natively.
 */

const IDS = 'To draft IDS checks return only JSON {"version":1,"kind":"ids.specifications","title","description"?,"ifcVersions":["IFC4"],'
  + '"specifications":[{"name","description"?,"instructions"?,"cardinality":"required|optional|prohibited","applicability":[facet],'
  + '"requirements":[facet + "cardinality"?: "required|optional|prohibited", "instructions"?]}],"unsupported":[...]}. '
  + 'Facets use the IDS 1.0 names: {"type":"entity","name":"IFCWALL","predefinedType"?}, {"type":"attribute","name":"Name","value"?}, '
  + '{"type":"property","propertySet":"Pset_WallCommon","baseName":"FireRating","dataType":"IFCLABEL","value"?,"unit"?}, '
  + '{"type":"classification","system","value"?}, {"type":"material","value"?}, '
  + '{"type":"partOf","relation":"IfcRelContainedInSpatialStructure|IfcRelAggregates|IfcRelAssignsToGroup|IfcRelNests","entity":{"name":"IFCBUILDINGSTOREY"}}. '
  + 'A value is text/number/boolean or {"type":"enumeration","values":[...]}, {"type":"pattern","pattern":"XSD regex"}, '
  + '{"type":"bounds","minInclusive"?,"maxInclusive"?,"minExclusive"?,"maxExclusive"?}. Entity names are exact classes (IFCWALL excludes IFCWALLSTANDARDCASE). '
  + '"unit" (mm, cm, m, mm2, m2, mm3, m3) is allowed only with IFCLENGTHMEASURE, IFCPOSITIVELENGTHMEASURE, IFCAREAMEASURE or IFCVOLUMEMEASURE and is converted to SI. ';

const RULES = 'To draft information rules (uniqueness, counts/sums, comparisons, units, which IDS cannot express) return only JSON '
  + '{"version":1,"kind":"rules.proposal","title","ruleSet":{"version":1,"name","rules":[{"id","name","severity":"error|warning",'
  + '"applicability":{"groups":[{"combinator":"AND","rules":[{"kind":"ifcType","values":["IfcWall"],"op":"in"}]}],"authoredAs":"chips"},'
  + '"requirement":{"kind":"element","block":{"groups":[{"combinator":"AND","rules":[{"kind":"property","setName":"Pset_WallCommon","propertyName":"FireRating","op":"isSet","value":""}]}],"authoredAs":"chips"}}}]},"unsupported":[...]}. '
  + 'Other requirements: {"kind":"unique","subject":{"kind":"name"}}, {"kind":"aggregate","fn":"count|sum|min|max|avg","subject"?,"op":"gte","value":1}, '
  + '{"kind":"compare","left":subject,"right":subject,"op":"lte"}, {"kind":"unit","subject":{"kind":"quantity","setName","quantityName"},"unit":"mm"}. '
  + 'Rule kinds: ifcType, name, attribute{name}, property{setName,propertyName}, quantity{setName,quantityName,op numeric,value number}, material, classification{system?}, storey{values}, type. ';

const DOCUMENT = 'To outline a validation report return only JSON {"version":1,"kind":"document.outline","title","sections":[{"heading",'
  + '"purpose":"summary|findings|changes|actions|coverage|other","blocks":[{"kind":"text","style":"body","text"},'
  + '{"kind":"validationTable","specification"?: "<specification id from the evidence>","rows":"failed|passed|all|sets",'
  + '"columns":["rule","result","entityType","name","globalId","model","actual","expected","reason"]},{"kind":"validationSummary"},{"kind":"pageBreak"}]}],"unsupported":[...]}. '
  + 'Never write counts or results into text: tables and summaries are filled from the live native report. ';

export const CHECK_AUTHORING_GUIDANCE = IDS + RULES + DOCUMENT
  + 'Requirements no listed facet or rule can check (geometry, clearances, free-text judgement, documents) go in "unsupported": '
  + '[{"text":"the requirement","reason":"why it cannot be checked","relatesTo"?: "specification/rule/section name"}]; never drop them. '
  + 'Use only property sets, classes and specification ids from the user or evidence; ask instead of guessing. '
  + 'The user audits, dry-runs on the loaded models and saves every draft; nothing is saved or run by the answer.';
