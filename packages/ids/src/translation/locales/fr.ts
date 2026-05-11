/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * French translations for IDS validation
 */

export const fr = {
  // ============================================================================
  // Status
  // ============================================================================
  status: {
    pass: 'CONFORME',
    fail: 'NON CONFORME',
    not_applicable: 'NON APPLICABLE',
  },

  // ============================================================================
  // Optionality / Cardinality
  // ============================================================================
  optionality: {
    required: 'Obligatoire',
    optional: 'Optionnel',
    prohibited: 'Interdit',
  },

  cardinality: {
    satisfied: 'Cardinalité respectée',
    atLeast: 'Au moins {min} attendu(s), {count} trouvé(s)',
    atMost: 'Au maximum {max} attendu(s), {count} trouvé(s)',
    between: 'Entre {min} et {max} attendu(s), {count} trouvé(s)',
    exactly: 'Exactement {count} attendu(s)',
  },

  // ============================================================================
  // Relationships
  // ============================================================================
  relations: {
    IfcRelAggregates: 'agrégé dans',
    IfcRelAssignsToGroup: 'groupé dans',
    IfcRelContainedInSpatialStructure: 'contenu dans',
    IfcRelNests: 'imbriqué dans',
    IfcRelVoidsElement: 'perçant',
    IfcRelFillsElement: 'remplissant',
  },

  // ============================================================================
  // Constraint Descriptions
  // ============================================================================
  constraints: {
    simpleValue: '"{value}"',
    pattern: 'correspondant au motif "{pattern}"',
    enumeration: {
      single: '"{value}"',
      multiple: "l'un de [{values}]",
    },
    bounds: {
      between: 'entre {min} et {max}',
      atLeast: 'au moins {min}',
      atMost: 'au plus {max}',
      greaterThan: 'supérieur à {min}',
      lessThan: 'inférieur à {max}',
    },
  },

  // ============================================================================
  // Applicability Descriptions
  // ============================================================================
  applicability: {
    entity: {
      simple: 'Éléments de type {entityType}',
      withPredefined: 'Éléments {entityType} avec type prédéfini {predefinedType}',
      pattern: 'Éléments avec type correspondant à {pattern}',
    },
    attribute: {
      exists: "Éléments où l'attribut \"{name}\" existe",
      equals: 'Éléments où "{name}" est égal à {value}',
      pattern: 'Éléments où "{name}" correspond au motif {pattern}',
    },
    property: {
      exists: 'Éléments avec propriété "{property}" dans "{pset}"',
      equals: 'Éléments où "{pset}.{property}" est égal à {value}',
      pattern: 'Éléments où "{pset}.{property}" correspond au motif {pattern}',
      bounded: 'Éléments où "{pset}.{property}" est {bounds}',
    },
    classification: {
      any: 'Éléments avec une classification quelconque',
      system: 'Éléments classifiés dans "{system}"',
      value: 'Éléments avec classification "{value}"',
      systemAndValue: 'Éléments classifiés comme "{value}" dans "{system}"',
    },
    material: {
      any: 'Éléments avec un matériau attribué',
      value: 'Éléments avec matériau "{value}"',
      pattern: 'Éléments avec matériau correspondant à {pattern}',
    },
    partOf: {
      simple: 'Éléments qui sont {relation} un autre élément',
      withEntity: 'Éléments qui sont {relation} un(e) {entity}',
      withEntityAndType: 'Éléments qui sont {relation} un(e) {entity} de type {predefinedType}',
    },
  },

  // ============================================================================
  // Requirement Descriptions
  // ============================================================================
  requirements: {
    entity: {
      mustBe: 'Doit être de type {entityType}',
      mustHavePredefined: 'Doit avoir le type prédéfini {predefinedType}',
      mustBeWithPredefined: 'Doit être {entityType} avec type prédéfini {predefinedType}',
    },
    attribute: {
      mustExist: "L'attribut \"{name}\" doit exister",
      mustEqual: "L'attribut \"{name}\" doit être égal à {value}",
      mustMatch: "L'attribut \"{name}\" doit correspondre au motif {pattern}",
      mustNotExist: "L'attribut \"{name}\" ne doit pas exister",
      mustNotEqual: "L'attribut \"{name}\" ne doit pas être {value}",
    },
    property: {
      mustExist: 'La propriété "{pset}.{property}" doit exister',
      mustEqual: 'La propriété "{pset}.{property}" doit être égale à {value}',
      mustMatch: 'La propriété "{pset}.{property}" doit correspondre au motif {pattern}',
      mustBeBounded: 'La propriété "{pset}.{property}" doit être {bounds}',
      mustHaveType: 'La propriété "{pset}.{property}" doit être de type {dataType}',
      mustNotExist: 'La propriété "{pset}.{property}" ne doit pas exister',
    },
    classification: {
      mustHave: 'Doit avoir une classification',
      mustBeInSystem: 'Doit être classifié dans "{system}"',
      mustHaveValue: 'Doit avoir la classification "{value}"',
      mustBeInSystemWithValue: 'Doit être classifié comme "{value}" dans "{system}"',
      mustNotHave: 'Ne doit pas avoir de classification',
      mustNotBeInSystem: 'Ne doit pas être classifié dans "{system}"',
    },
    material: {
      mustHave: 'Doit avoir un matériau attribué',
      mustBe: 'Doit avoir le matériau "{value}"',
      mustMatch: 'Doit avoir un matériau correspondant à {pattern}',
      mustNotHave: 'Ne doit pas avoir de matériau attribué',
    },
    partOf: {
      mustBe: 'Doit être {relation} un(e) {entity}',
      mustBeSimple: 'Doit être {relation} un autre élément',
      mustNotBe: 'Ne doit pas être {relation} un élément',
    },
  },

  // ============================================================================
  // Failure Reasons
  // ============================================================================
  failures: {
    // Entity failures
    entityTypeMismatch: "Le type d'élément est \"{actual}\", attendu {expected}",
    predefinedTypeMismatch: 'Le type prédéfini est "{actual}", attendu {expected}',
    predefinedTypeMissing: "Le type prédéfini n'est pas défini, attendu {expected}",

    // Attribute failures
    attributeMissing: "L'attribut \"{name}\" n'existe pas",
    attributeEmpty: "L'attribut \"{name}\" est vide",
    attributeValueMismatch: "L'attribut \"{name}\" est \"{actual}\", attendu {expected}",
    attributePatternMismatch: "La valeur de l'attribut \"{name}\" \"{actual}\" ne correspond pas au motif {expected}",
    attributeProhibited: "L'attribut interdit \"{name}\" existe avec la valeur \"{actual}\"",

    // Property failures
    psetMissing: "L'ensemble de propriétés \"{pset}\" n'a pas été trouvé",
    psetMissingAvailable: "L'ensemble de propriétés \"{pset}\" n'a pas été trouvé. Disponibles : {available}",
    propertyMissing: 'La propriété "{property}" n\'a pas été trouvée dans "{pset}"',
    propertyMissingAvailable: 'La propriété "{property}" n\'a pas été trouvée dans "{pset}". Disponibles : {available}',
    propertyEmpty: 'La propriété "{pset}.{property}" n\'a pas de valeur',
    propertyValueMismatch: 'La propriété "{pset}.{property}" est "{actual}", attendu {expected}',
    propertyPatternMismatch: 'La valeur de la propriété "{pset}.{property}" "{actual}" ne correspond pas à {expected}',
    propertyDatatypeMismatch: 'Le type de données de la propriété "{pset}.{property}" est "{actual}", attendu {expected}',
    propertyOutOfBounds: 'La valeur de la propriété "{pset}.{property}" {actual} est hors de la plage {expected}',
    propertyProhibited: 'La propriété interdite "{pset}.{property}" existe avec la valeur "{actual}"',

    // Classification failures
    classificationMissing: 'Aucune classification attribuée',
    classificationSystemMismatch: 'Le système de classification "{actual}" ne correspond pas à "{expected}" attendu',
    classificationSystemMissingAvailable: 'Le système de classification "{expected}" n\'a pas été trouvé. Disponibles : {available}',
    classificationValueMismatch: 'Le code de classification "{actual}" ne correspond pas à {expected} attendu',
    classificationValueMissingAvailable: 'Le code de classification {expected} n\'a pas été trouvé. Disponibles : {available}',
    classificationProhibited: 'La classification interdite "{actual}" existe dans le système "{system}"',

    // Material failures
    materialMissing: 'Aucun matériau attribué',
    materialValueMismatch: 'Le matériau "{actual}" ne correspond pas à {expected} attendu',
    materialValueMissingAvailable: 'Le matériau {expected} n\'a pas été trouvé. Disponibles : {available}',
    materialProhibited: 'Le matériau interdit "{actual}" est attribué',

    // PartOf failures
    partOfMissing: "L'élément n'est pas {relation} un(e) {entity}",
    partOfMissingSimple: "L'élément n'est pas {relation} un autre élément",
    partOfEntityMismatch: "L'élément parent est {actual}, attendu {expected}",
    partOfPredefinedMismatch: 'Le type prédéfini de l\'élément parent est "{actual}", attendu {expected}',
    partOfProhibited: "L'élément est {relation} {actual}, ce qui est interdit",

    // Generic
    prohibited: '{field} interdit trouvé : "{actual}"',
    unknown: 'Validation échouée : {reason}',
  },

  // ============================================================================
  // Summary
  // ============================================================================
  summary: {
    title: 'Rapport de validation IDS',
    specifications: '{passed}/{total} spécifications conformes',
    entities: '{passed}/{total} éléments conformes ({percent}%)',
    overallPass: 'Le modèle respecte toutes les exigences',
    overallFail: 'Le modèle a {count} spécifications non conformes',
    noApplicable: 'Aucun élément applicable trouvé',
  },

  // ============================================================================
  // UI Labels
  // ============================================================================
  ui: {
    specification: 'Spécification',
    specifications: 'Spécifications',
    requirement: 'Exigence',
    requirements: 'Exigences',
    applicability: "S'applique à",
    entity: 'Élément',
    entities: 'Éléments',
    passed: 'Conforme',
    failed: 'Non conforme',
    passRate: 'Taux de conformité',
    actualValue: 'Réel',
    expectedValue: 'Attendu',
    failureReason: 'Raison',
    showAll: 'Afficher tout',
    showFailed: 'Afficher non conformes',
    isolateFailed: 'Isoler non conformes',
    isolatePassed: 'Isoler conformes',
    exportJson: 'Exporter JSON',
    exportBcf: 'Exporter BCF',
    loadIds: 'Charger fichier IDS',
    runValidation: 'Lancer la validation',
    clearResults: 'Effacer les résultats',
  },
};
