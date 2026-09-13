/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ALLOWLIST for scripts/check-server-browser-type-parity.mjs. Split out
 * purely to stay under the module-size budget (AGENTS.md: "Prefer splitting
 * to allowlisting") once #4205 added the schema-derived HIERARCHY_REL_TYPES
 * rows below — see the parent file's header for the overall approach
 * (`checkConcept`, `staleAllowlistEntries`) this is read together with.
 */

/**
 * The allowlist. Every key is `${concept}:${TYPE_NAME}`. Every value is
 * `{ status, note }`:
 *
 *   - `status: 'deliberate'` — a SETTLED trade-off with its own tracking
 *     issue (e.g. #3254). Nobody is going to "fix" this; the note says why
 *     not, and a future agent should read the linked issue before touching
 *     either side's behaviour here.
 *   - `status: 'pending'` — a KNOWN divergence with an open PR already
 *     addressing it, OR flagged to a maintainer with the resolution not yet
 *     decided (e.g. "drop it / add it to the other side / keep and
 *     allowlist" are all still on the table). This gate does not assume an
 *     outcome: it only records that the gap is known and not silent.
 *
 * The distinction matters because the two failure modes it guards against
 * are different: a `deliberate` entry that quietly starts being used as
 * cover for an unrelated new gap is caught by this gate still comparing the
 * type EXACTLY (an allowlist entry suppresses one named type on one named
 * side, never a whole concept); a `pending` entry that outlives its PR
 * closing keeps citing a merged issue number, which is the trigger to
 * re-check whether it can be deleted.
 *
 * An entry here does not fix or hide the divergence: the type genuinely IS
 * absent from one side today, and a reader of this file can go verify that.
 */
export const ALLOWLIST = {
  // #3964: server extracted 9 IfcRel* types, TS ~19. PR #3969 (merged) added
  // IfcRelAssignsToGroup(ByFactor)/Nests/ConnectsPathElements server-side —
  // those 4 entries are gone from this list because `staleAllowlistEntries()`
  // (see the file header) confirmed the Rust source now names them; do not
  // re-add them without re-confirming they diverge again. The remaining
  // connect/port/space-boundary/referenced-in-spatial-structure types below
  // are the same shape of gap, still open, and tracked under the same issue.
  'relationships:IFCRELCONNECTSELEMENTS': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELCONNECTSPORTTOELEMENT': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELCONNECTSPORTS': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELSPACEBOUNDARY': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELASSIGNSTOPRODUCT': { status: 'pending', note: '#3964, tracked with #3969' },
  'relationships:IFCRELREFERENCEDINSPATIALSTRUCTURE': { status: 'pending', note: '#3964, tracked with #3969' },

  // #4205: HIERARCHY_REL_TYPES (packages/parser/src/columnar-parser-indexes.ts)
  // switched from a ~19-entry hand-written literal to every concrete
  // `IfcRelationship` subtype the bundled schemas declare
  // (`getAllConcreteRelationshipTypes()`), so the TS parser now recognizes
  // every one of the 55 concrete subtypes across IFC2X3/IFC4/IFC4X3 — most
  // of them (task/resource assignment, structural-analysis connections,
  // space-boundary variants, ...) the Rust server's narrower data model
  // (`apps/server/src/services/data_model/relationships.rs`, still the
  // pre-#4205 9-type list) was never asked to handle. This is the intended
  // shape of #4205 (index every subtype, once, from the schema) rather than
  // a regression: extending the Rust server to match is tracked by #4205
  // itself, not a silent, undocumented gap.
  'relationships:IFCRELADHERESTOELEMENT': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSIGNSTASKS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSIGNSTOACTOR': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSIGNSTOCONTROL': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSIGNSTOPROCESS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSIGNSTOPROJECTORDER': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSIGNSTORESOURCE': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATES': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATESAPPLIEDVALUE': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATESAPPROVAL': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATESCONSTRAINT': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATESLIBRARY': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATESPROFILEDEF': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELASSOCIATESPROFILEPROPERTIES': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCONNECTSSTRUCTURALACTIVITY': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCONNECTSSTRUCTURALELEMENT': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCONNECTSSTRUCTURALMEMBER': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCONNECTSWITHECCENTRICITY': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCONNECTSWITHREALIZINGELEMENTS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCOVERSBLDGELEMENTS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELCOVERSSPACES': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELDECLARES': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELDEFINESBYOBJECT': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELDEFINESBYTEMPLATE': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELFLOWCONTROLELEMENTS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELINTERACTIONREQUIREMENTS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELINTERFERESELEMENTS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELOCCUPIESSPACES': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELOVERRIDESPROPERTIES': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELPOSITIONS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELPROJECTSELEMENT': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELSCHEDULESCOSTITEMS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELSEQUENCE': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELSERVICESBUILDINGS': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELSPACEBOUNDARY1STLEVEL': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },
  'relationships:IFCRELSPACEBOUNDARY2NDLEVEL': { status: 'pending', note: '#4205: TS now derives relationship coverage from the schema (getAllConcreteRelationshipTypes); the Rust server data model has not been extended to match' },

  // #3254: IfcPhysicalComplexQuantity groups other quantities instead of
  // carrying a measure itself, so neither side resolves it to a Quantity —
  // this is a DELIBERATE, tracked trade-off, not an in-flight fix. The
  // server never names the type at all; the TS side names it only to skip
  // it explicitly (`quantity-collect.ts`'s COMPLEX_QUANTITY_TYPE). Do not
  // remove this entry to "fix" the gap — see #3254 before changing either
  // side's behaviour here.
  'quantities:IFCPHYSICALCOMPLEXQUANTITY': { status: 'deliberate', note: '#3254 (deliberate, tracked gap)' },
};
