/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translation service for IDS validation reports
 */

import type {
  IDSFacet,
  IDSConstraint,
  IDSRequirement,
  IDSRequirementResult,
  SupportedLocale,
  TranslationService,
  PartOfRelation,
  RequirementOptionality,
} from '../types.js';

import {
  describeConstraint as renderConstraint,
  interpolate as interpolateTemplate,
} from './describe-constraint.js';
import { en } from './locales/en.js';
import { de } from './locales/de.js';
import { fr } from './locales/fr.js';

type Translations = typeof en;

const LOCALES: Record<SupportedLocale, Translations> = {
  en,
  de,
  fr,
};

/**
 * Create a translation service for the specified locale
 */
export function createTranslationService(
  locale: SupportedLocale = 'en'
): TranslationService {
  return new IDSTranslationServiceImpl(locale);
}

class IDSTranslationServiceImpl implements TranslationService {
  readonly locale: SupportedLocale;
  private translations: Translations;

  constructor(locale: SupportedLocale) {
    this.locale = locale;
    this.translations = LOCALES[locale] || LOCALES.en;
  }

  /**
   * Translate a key with parameter interpolation
   */
  t(key: string, params?: Record<string, string | number>): string {
    // Navigate to the translation value
    const parts = key.split('.');
    let value: unknown = this.translations;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        // Key not found, return the key itself
        return key;
      }
    }

    if (typeof value !== 'string') {
      return key;
    }

    // Interpolate parameters
    if (params) {
      return this.interpolate(value, params);
    }

    return value;
  }

  /**
   * Interpolate parameters into a string
   */
  private interpolate(
    template: string,
    params: Record<string, string | number>
  ): string {
    return interpolateTemplate(template, params);
  }

  /**
   * Describe a constraint value in human-readable form
   */
  describeConstraint(constraint: IDSConstraint): string {
    return renderConstraint(constraint, this.translations);
  }

  /**
   * Describe a facet in human-readable form
   */
  describeFacet(
    facet: IDSFacet,
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;

    switch (facet.type) {
      case 'entity':
        return this.describeEntityFacet(facet, context);
      case 'attribute':
        return this.describeAttributeFacet(facet, context);
      case 'property':
        return this.describePropertyFacet(facet, context);
      case 'classification':
        return this.describeClassificationFacet(facet, context);
      case 'material':
        return this.describeMaterialFacet(facet, context);
      case 'partOf':
        return this.describePartOfFacet(facet, context);
      default:
        return 'Unknown facet';
    }
  }

  private describeEntityFacet(
    facet: IDSFacet & { type: 'entity' },
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;
    const entityType = this.describeConstraint(facet.name);

    if (context === 'applicability') {
      if (facet.predefinedType) {
        return this.interpolate(t.applicability.entity.withPredefined, {
          entityType,
          predefinedType: this.describeConstraint(facet.predefinedType),
        });
      }
      return this.interpolate(t.applicability.entity.simple, { entityType });
    } else {
      if (facet.predefinedType) {
        return this.interpolate(t.requirements.entity.mustBeWithPredefined, {
          entityType,
          predefinedType: this.describeConstraint(facet.predefinedType),
        });
      }
      return this.interpolate(t.requirements.entity.mustBe, { entityType });
    }
  }

  private describeAttributeFacet(
    facet: IDSFacet & { type: 'attribute' },
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;
    const name = this.describeConstraint(facet.name);

    if (context === 'applicability') {
      if (facet.value) {
        if (facet.value.type === 'pattern') {
          return this.interpolate(t.applicability.attribute.pattern, {
            name,
            pattern: this.describeConstraint(facet.value),
          });
        }
        return this.interpolate(t.applicability.attribute.equals, {
          name,
          value: this.describeConstraint(facet.value),
        });
      }
      return this.interpolate(t.applicability.attribute.exists, { name });
    } else {
      if (facet.value) {
        if (facet.value.type === 'pattern') {
          return this.interpolate(t.requirements.attribute.mustMatch, {
            name,
            pattern: this.describeConstraint(facet.value),
          });
        }
        return this.interpolate(t.requirements.attribute.mustEqual, {
          name,
          value: this.describeConstraint(facet.value),
        });
      }
      return this.interpolate(t.requirements.attribute.mustExist, { name });
    }
  }

  private describePropertyFacet(
    facet: IDSFacet & { type: 'property' },
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;
    const pset = this.describeConstraint(facet.propertySet);
    const property = this.describeConstraint(facet.baseName);

    if (context === 'applicability') {
      if (facet.value) {
        if (facet.value.type === 'pattern') {
          return this.interpolate(t.applicability.property.pattern, {
            pset,
            property,
            pattern: this.describeConstraint(facet.value),
          });
        }
        if (facet.value.type === 'bounds') {
          return this.interpolate(t.applicability.property.bounded, {
            pset,
            property,
            bounds: this.describeConstraint(facet.value),
          });
        }
        return this.interpolate(t.applicability.property.equals, {
          pset,
          property,
          value: this.describeConstraint(facet.value),
        });
      }
      return this.interpolate(t.applicability.property.exists, {
        pset,
        property,
      });
    } else {
      if (facet.value) {
        if (facet.value.type === 'pattern') {
          return this.interpolate(t.requirements.property.mustMatch, {
            pset,
            property,
            pattern: this.describeConstraint(facet.value),
          });
        }
        if (facet.value.type === 'bounds') {
          return this.interpolate(t.requirements.property.mustBeBounded, {
            pset,
            property,
            bounds: this.describeConstraint(facet.value),
          });
        }
        return this.interpolate(t.requirements.property.mustEqual, {
          pset,
          property,
          value: this.describeConstraint(facet.value),
        });
      }
      return this.interpolate(t.requirements.property.mustExist, {
        pset,
        property,
      });
    }
  }

  private describeClassificationFacet(
    facet: IDSFacet & { type: 'classification' },
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;

    if (context === 'applicability') {
      if (facet.system && facet.value) {
        return this.interpolate(t.applicability.classification.systemAndValue, {
          system: this.describeConstraint(facet.system),
          value: this.describeConstraint(facet.value),
        });
      }
      if (facet.system) {
        return this.interpolate(t.applicability.classification.system, {
          system: this.describeConstraint(facet.system),
        });
      }
      if (facet.value) {
        return this.interpolate(t.applicability.classification.value, {
          value: this.describeConstraint(facet.value),
        });
      }
      return t.applicability.classification.any;
    } else {
      if (facet.system && facet.value) {
        return this.interpolate(
          t.requirements.classification.mustBeInSystemWithValue,
          {
            system: this.describeConstraint(facet.system),
            value: this.describeConstraint(facet.value),
          }
        );
      }
      if (facet.system) {
        return this.interpolate(t.requirements.classification.mustBeInSystem, {
          system: this.describeConstraint(facet.system),
        });
      }
      if (facet.value) {
        return this.interpolate(t.requirements.classification.mustHaveValue, {
          value: this.describeConstraint(facet.value),
        });
      }
      return t.requirements.classification.mustHave;
    }
  }

  private describeMaterialFacet(
    facet: IDSFacet & { type: 'material' },
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;

    if (context === 'applicability') {
      if (facet.value) {
        if (facet.value.type === 'pattern') {
          return this.interpolate(t.applicability.material.pattern, {
            pattern: this.describeConstraint(facet.value),
          });
        }
        return this.interpolate(t.applicability.material.value, {
          value: this.describeConstraint(facet.value),
        });
      }
      return t.applicability.material.any;
    } else {
      if (facet.value) {
        if (facet.value.type === 'pattern') {
          return this.interpolate(t.requirements.material.mustMatch, {
            pattern: this.describeConstraint(facet.value),
          });
        }
        return this.interpolate(t.requirements.material.mustBe, {
          value: this.describeConstraint(facet.value),
        });
      }
      return t.requirements.material.mustHave;
    }
  }

  private describePartOfFacet(
    facet: IDSFacet & { type: 'partOf' },
    context: 'applicability' | 'requirement'
  ): string {
    const t = this.translations;
    const relation = this.getRelationDescription(facet.relation);

    if (context === 'applicability') {
      if (facet.entity) {
        if (facet.entity.predefinedType) {
          return this.interpolate(t.applicability.partOf.withEntityAndType, {
            relation,
            entity: this.describeConstraint(facet.entity.name),
            predefinedType: this.describeConstraint(facet.entity.predefinedType),
          });
        }
        return this.interpolate(t.applicability.partOf.withEntity, {
          relation,
          entity: this.describeConstraint(facet.entity.name),
        });
      }
      return this.interpolate(t.applicability.partOf.simple, { relation });
    } else {
      if (facet.entity) {
        return this.interpolate(t.requirements.partOf.mustBe, {
          relation,
          entity: this.describeConstraint(facet.entity.name),
        });
      }
      return this.interpolate(t.requirements.partOf.mustBeSimple, { relation });
    }
  }


  /**
   * Describe a failure in human-readable form
   */
  describeFailure(result: IDSRequirementResult): string {
    const t = this.translations.failures;

    if (!result.failure) {
      if (result.actualValue && result.expectedValue) {
        return `${result.actualValue} ≠ ${result.expectedValue}`;
      }
      return t.unknown.replace('{reason}', 'no details');
    }

    const { type, field, actual, expected, context } = result.failure;

    switch (type) {
      // Entity failures
      case 'ENTITY_TYPE_MISMATCH':
        return this.interpolate(t.entityTypeMismatch, {
          actual: actual || '?',
          expected: expected || '?',
        });

      case 'PREDEFINED_TYPE_MISMATCH':
        return this.interpolate(t.predefinedTypeMismatch, {
          actual: actual || '?',
          expected: expected || '?',
        });

      case 'PREDEFINED_TYPE_MISSING':
        return this.interpolate(t.predefinedTypeMissing, {
          expected: expected || '?',
        });

      // Attribute failures
      case 'ATTRIBUTE_MISSING':
        return this.interpolate(t.attributeMissing, {
          name: field || '?',
        });

      case 'ATTRIBUTE_VALUE_MISMATCH':
        return this.interpolate(t.attributeValueMismatch, {
          name: field || '?',
          actual: actual || '?',
          expected: expected || '?',
        });

      case 'ATTRIBUTE_PATTERN_MISMATCH':
        return this.interpolate(t.attributePatternMismatch, {
          name: field || '?',
          actual: actual || '?',
          expected: expected || '?',
        });

      // Property failures
      case 'PSET_MISSING':
        if (context?.availablePsets) {
          return this.interpolate(t.psetMissingAvailable, {
            pset: field || expected || '?',
            available: context.availablePsets,
          });
        }
        return this.interpolate(t.psetMissing, {
          pset: field || expected || '?',
        });

      case 'PROPERTY_MISSING':
        if (context?.availableProperties) {
          return this.interpolate(t.propertyMissingAvailable, {
            property: field || '?',
            pset: context.propertySet || '?',
            available: context.availableProperties,
          });
        }
        return this.interpolate(t.propertyMissing, {
          property: field || '?',
          pset: context?.propertySet || '?',
        });

      case 'PROPERTY_VALUE_MISMATCH':
        return this.interpolate(t.propertyValueMismatch, {
          pset: this.extractPsetFromField(field),
          property: this.extractPropertyFromField(field),
          actual: actual || '?',
          expected: expected || '?',
        });

      case 'PROPERTY_DATATYPE_MISMATCH':
        return this.interpolate(t.propertyDatatypeMismatch, {
          pset: this.extractPsetFromField(field),
          property: this.extractPropertyFromField(field),
          actual: actual || '?',
          expected: expected || '?',
        });

      case 'PROPERTY_OUT_OF_BOUNDS':
        return this.interpolate(t.propertyOutOfBounds, {
          pset: this.extractPsetFromField(field),
          property: this.extractPropertyFromField(field),
          actual: actual || '?',
          expected: expected || '?',
        });

      // Classification failures
      case 'CLASSIFICATION_MISSING':
        return t.classificationMissing;

      case 'CLASSIFICATION_SYSTEM_MISMATCH':
        if (context?.availableSystems) {
          return this.interpolate(t.classificationSystemMissingAvailable, {
            expected: expected || '?',
            available: context.availableSystems,
          });
        }
        return this.interpolate(t.classificationSystemMismatch, {
          actual: actual || '?',
          expected: expected || '?',
        });

      case 'CLASSIFICATION_VALUE_MISMATCH':
        if (context?.availableValues) {
          return this.interpolate(t.classificationValueMissingAvailable, {
            expected: expected || '?',
            available: context.availableValues,
          });
        }
        return this.interpolate(t.classificationValueMismatch, {
          actual: actual || '?',
          expected: expected || '?',
        });

      // Material failures
      case 'MATERIAL_MISSING':
        return t.materialMissing;

      case 'MATERIAL_VALUE_MISMATCH':
        if (context?.availableMaterials) {
          return this.interpolate(t.materialValueMissingAvailable, {
            expected: expected || '?',
            available: context.availableMaterials,
          });
        }
        return this.interpolate(t.materialValueMismatch, {
          actual: actual || '?',
          expected: expected || '?',
        });

      // PartOf failures
      case 'PARTOF_RELATION_MISSING':
        if (context?.entity) {
          return this.interpolate(t.partOfMissing, {
            relation: this.getRelationDescription(
              field as PartOfRelation || 'IfcRelContainedInSpatialStructure'
            ),
            entity: context.entity,
          });
        }
        return this.interpolate(t.partOfMissingSimple, {
          relation: this.getRelationDescription(
            field as PartOfRelation || 'IfcRelContainedInSpatialStructure'
          ),
        });

      case 'PARTOF_ENTITY_MISMATCH':
        return this.interpolate(t.partOfEntityMismatch, {
          actual: actual || '?',
          expected: expected || '?',
        });

      // Prohibited failures
      case 'PROHIBITED_ATTRIBUTE_EXISTS':
      case 'PROHIBITED_PROPERTY_EXISTS':
      case 'PROHIBITED_CLASSIFICATION_EXISTS':
      case 'PROHIBITED_MATERIAL_EXISTS':
        return this.interpolate(t.prohibited, {
          field: field || 'value',
          actual: actual || '?',
        });

      default:
        return this.interpolate(t.unknown, { reason: type });
    }
  }

  private extractPsetFromField(field?: string): string {
    if (!field) return '?';
    const parts = field.split('.');
    return parts.length > 1 ? parts[0] : '?';
  }

  private extractPropertyFromField(field?: string): string {
    if (!field) return '?';
    const parts = field.split('.');
    return parts.length > 1 ? parts.slice(1).join('.') : field;
  }

  /**
   * Describe a requirement in human-readable form
   */
  describeRequirement(requirement: IDSRequirement): string {
    let description = this.describeFacet(requirement.facet, 'requirement');

    // Apply optionality modifiers
    if (requirement.optionality === 'prohibited') {
      description = this.applyProhibited(description);
    } else if (requirement.optionality === 'optional') {
      description = this.applyOptional(description);
    }

    return description;
  }

  private applyProhibited(description: string): string {
    // Replace "Must" with "Must NOT" etc.
    return description
      .replace(/^Must be/i, 'Must NOT be')
      .replace(/^Must have/i, 'Must NOT have')
      .replace(/^Muss/i, 'Darf nicht')
      .replace(/^Doit être/i, 'Ne doit pas être')
      .replace(/^Doit avoir/i, 'Ne doit pas avoir');
  }

  private applyOptional(description: string): string {
    // Replace "Must" with "Should" etc.
    return description
      .replace(/^Must/i, 'Should')
      .replace(/^Muss/i, 'Sollte')
      .replace(/^Doit/i, 'Devrait');
  }

  /**
   * Get status text
   */
  getStatusText(status: 'pass' | 'fail' | 'not_applicable'): string {
    return this.translations.status[status];
  }

  /**
   * Get optionality text
   */
  getOptionalityText(optionality: RequirementOptionality): string {
    return this.translations.optionality[optionality];
  }

  /**
   * Get human-readable relationship description
   */
  getRelationDescription(relation: PartOfRelation): string {
    return (
      this.translations.relations[relation] ||
      relation.replace('IfcRel', '').toLowerCase()
    );
  }
}

export { IDSTranslationServiceImpl };
