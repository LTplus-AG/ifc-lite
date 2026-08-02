/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.ids — IDS (Information Delivery Specification) validation
 *
 * Full access to @ifc-lite/ids for parsing, validating, and reporting
 * IDS documents. Includes facet checking, constraint matching, and
 * multi-language translation (EN, DE, FR).
 */

// ============================================================================
// Summary type (standalone — no dependency on @ifc-lite/ids types at compile time)
// ============================================================================

export interface IDSValidationSummary {
  totalSpecifications: number;
  passedSpecifications: number;
  failedSpecifications: number;
  totalEntities: number;
  passedEntities: number;
  failedEntities: number;
}

export type IDSSupportedLocale = 'en' | 'de' | 'fr';

/** Progress shape emitted by the @ifc-lite/ids validator. */
export interface IDSValidationProgress {
  phase: 'filtering' | 'validating' | 'complete';
  specificationIndex: number;
  totalSpecifications: number;
  entitiesProcessed: number;
  totalEntities: number;
  percentage: number;
}

export interface IDSValidateOptions {
  /** IFC data accessor — maps IFC model data for validation */
  accessor: unknown;
  /** Model info (schema version, name, etc.) for spec applicability checks */
  modelInfo?: { schemaVersion?: string; name?: string; [key: string]: unknown };
  /** Progress callback */
  onProgress?: (progress: IDSValidationProgress) => void;
  /** Locale for human-readable messages */
  locale?: IDSSupportedLocale;
  /**
   * Whether per-entity results for PASSING entities are retained in the
   * report (default true). Disable for summary/failure-focused flows on
   * large models — pass/fail counts stay correct either way.
   */
  includePassingEntities?: boolean;
}

// ============================================================================
// Dynamic import
// ============================================================================

async function loadIDS(): Promise<Record<string, unknown>> {
  const name = '@ifc-lite/ids';
  return import(/* webpackIgnore: true */ name) as Promise<Record<string, unknown>>;
}

type AnyFn = (...args: unknown[]) => unknown;

// ============================================================================
// IDSNamespace
// ============================================================================

/** bim.ids — IDS (Information Delivery Specification) parsing, validation, and reporting */
export class IDSNamespace {

  // --------------------------------------------------------------------------
  // Parsing
  // --------------------------------------------------------------------------

  /** Parse an IDS XML document into an IDSDocument structure. */
  async parse(xmlContent: string): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.parseIDS as (xml: string) => unknown)(xmlContent);
  }

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  /**
   * Validate an IDS document against an IFC model.
   *
   * ```ts
   * const ids = await bim.ids.parse(idsXml);
   * const report = await bim.ids.validate(ids, { accessor: myDataAccessor });
   * console.log(bim.ids.summarize(report));
   * ```
   */
  async validate(idsDocument: unknown, options: IDSValidateOptions): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.validateIDS as AnyFn)(idsDocument, options.accessor, options.modelInfo ?? {}, {
      onProgress: options.onProgress,
      locale: options.locale,
      includePassingEntities: options.includePassingEntities,
    });
  }

  // --------------------------------------------------------------------------
  // Facet operations
  // --------------------------------------------------------------------------

  /** Check a single facet against an entity. Returns { passed, details }. */
  async checkFacet(facet: unknown, entityData: unknown, accessor: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkFacet as AnyFn)(facet, entityData, accessor);
  }

  /** Filter entities by a facet. Returns matching entity IDs. */
  async filterByFacet(facet: unknown, entities: unknown[], accessor: unknown): Promise<unknown[]> {
    const mod = await loadIDS();
    return (mod.filterByFacet as AnyFn)(facet, entities, accessor) as Promise<unknown[]>;
  }

  /** Check an entity facet (IfcType matching). */
  async checkEntityFacet(facet: unknown, entityData: unknown, accessor: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkEntityFacet as AnyFn)(facet, entityData, accessor);
  }

  /** Filter entities by entity facet (IfcType). */
  async filterByEntityFacet(facet: unknown, entities: unknown[], accessor: unknown): Promise<unknown[]> {
    const mod = await loadIDS();
    return (mod.filterByEntityFacet as AnyFn)(facet, entities, accessor) as Promise<unknown[]>;
  }

  /** Check an attribute facet (Name, Description, ObjectType). */
  async checkAttributeFacet(facet: unknown, entityData: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkAttributeFacet as AnyFn)(facet, entityData);
  }

  /** Check a property facet (PropertySet + Property value). */
  async checkPropertyFacet(facet: unknown, entityData: unknown, accessor: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkPropertyFacet as AnyFn)(facet, entityData, accessor);
  }

  /** Check a classification facet. */
  async checkClassificationFacet(facet: unknown, entityData: unknown, accessor: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkClassificationFacet as AnyFn)(facet, entityData, accessor);
  }

  /** Check a material facet. */
  async checkMaterialFacet(facet: unknown, entityData: unknown, accessor: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkMaterialFacet as AnyFn)(facet, entityData, accessor);
  }

  /** Check a part-of facet (spatial/aggregation relationships). */
  async checkPartOfFacet(facet: unknown, entityData: unknown, accessor: unknown): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.checkPartOfFacet as AnyFn)(facet, entityData, accessor);
  }

  // --------------------------------------------------------------------------
  // Constraint operations
  // --------------------------------------------------------------------------

  /** Match a value against an IDS constraint. */
  async matchConstraint(constraint: unknown, value: unknown): Promise<boolean> {
    const mod = await loadIDS();
    return (mod.matchConstraint as (c: unknown, v: unknown) => boolean)(constraint, value);
  }

  /** Format a constraint as a human-readable string. */
  async formatConstraint(constraint: unknown): Promise<string> {
    const mod = await loadIDS();
    return (mod.formatConstraint as (c: unknown) => string)(constraint);
  }

  /** Get a human-readable mismatch reason for a failed constraint. */
  async getConstraintMismatchReason(constraint: unknown, value: unknown): Promise<string> {
    const mod = await loadIDS();
    return (mod.getConstraintMismatchReason as (c: unknown, v: unknown) => string)(constraint, value);
  }

  // --------------------------------------------------------------------------
  // Translation
  // --------------------------------------------------------------------------

  /** Create a translation service for human-readable validation messages. */
  async createTranslationService(locale?: IDSSupportedLocale): Promise<unknown> {
    const mod = await loadIDS();
    return (mod.createTranslationService as AnyFn)(locale ?? 'en');
  }

  /** Get locale data for customization. */
  async getLocale(locale: IDSSupportedLocale): Promise<unknown> {
    const mod = await loadIDS();
    return mod[locale];
  }

  // --------------------------------------------------------------------------
  // Report summarization
  // --------------------------------------------------------------------------

  /** Summarize a validation report into pass/fail counts. */
  summarize(report: {
    specificationResults: Array<{
      entityResults: Array<{ passed: boolean }>;
      status?: 'pass' | 'fail' | 'not_applicable';
    }>;
  }): IDSValidationSummary {
    let totalSpecs = 0, passedSpecs = 0, failedSpecs = 0;
    let totalEntities = 0, passedEntities = 0, failedEntities = 0;

    for (const spec of report.specificationResults) {
      totalSpecs++;
      let anyEntityFailed = false;
      for (const entity of spec.entityResults) {
        totalEntities++;
        if (entity.passed) passedEntities++;
        else { failedEntities++; anyEntityFailed = true; }
      }
      // Prefer the validator's own verdict when present: it also covers
      // cardinality-only failures (e.g. a required spec matching zero
      // entities), which entity results alone cannot express. Deriving
      // from entities here used to make this summary disagree with the
      // validator's report.summary for exactly those specs.
      const specFailed = spec.status !== undefined ? spec.status === 'fail' : anyEntityFailed;
      if (specFailed) failedSpecs++;
      else passedSpecs++;
    }

    return { totalSpecifications: totalSpecs, passedSpecifications: passedSpecs, failedSpecifications: failedSpecs, totalEntities, passedEntities, failedEntities };
  }
}
