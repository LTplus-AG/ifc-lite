/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The run document's JSON Schema (draft 2020-12), as plain data: no load-time
 * calls, so the module stays droppable for a bundle that does not use it.
 * Version 1 is closed (`additionalProperties: false` on every fixed shape).
 * `validateClashRunDocument` (run-document-schema.ts) checks the same shape
 * plus consistency between findings and the manifest; the two are kept in step
 * by `run-document.test.ts` (required fields) and the validator tests.
 */

import { CLASH_RUN_DOCUMENT_SCHEMA_ID, CLASH_RUN_DOCUMENT_VERSION } from './run-document.js';

/** The run document's JSON Schema. */
export const CLASH_RUN_DOCUMENT_JSON_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": CLASH_RUN_DOCUMENT_SCHEMA_ID,
  "title": "ifc-lite clash run",
  "description": "Version 1 is closed: unknown properties are refused; a new field means a new version. Consistency between findings and the manifest (keys, rule revisions, unique ids) is checked by validateClashRunDocument.",
  "type": "object",
  "required": ["schema", "version", "runId", "createdAt", "labels", "manifest", "findings"],
  "properties": {
    "schema": { "const": CLASH_RUN_DOCUMENT_SCHEMA_ID },
    "version": { "const": CLASH_RUN_DOCUMENT_VERSION },
    "runId": {"type": ["string", "null"]},
    "createdAt": {"type": "string", "format": "date-time"},
    "labels": {"type": "array", "items": {"type": "string"}},
    "manifest": {
      "type": "object",
      "required": [
        "slots",
        "rules",
        "engine",
        "settings",
        "coverage",
        "ambiguousKeys",
        "exclusions",
        "exclusionRules",
        "exclusionTypes",
        "truncated",
      ],
      "properties": {
        "slots": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["slot", "sha256"],
            "properties": {
              "slot": {"type": "string"},
              "sha256": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$"},
              "label": {"type": "string"},
              "name": {"type": "string"},
            },
            "additionalProperties": false,
          },
        },
        "rules": {
          "type": "object",
          "required": ["revision", "items"],
          "properties": {
            "revision": {"type": "string"},
            "items": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "id",
                  "name",
                  "revision",
                  "a",
                  "b",
                  "mode",
                  "tolerance",
                  "clearance",
                  "reportTouch",
                  "explicitMembers",
                ],
                "properties": {
                  "id": {"type": "string"},
                  "name": {"type": "string"},
                  "revision": {"type": "string"},
                  "a": {"type": "string"},
                  "b": {"type": ["string", "null"]},
                  "mode": {"enum": ["hard", "clearance"]},
                  "tolerance": {"type": "number"},
                  "clearance": {"type": ["number", "null"]},
                  "reportTouch": {"type": "boolean"},
                  "explicitMembers": {
                    "type": "object",
                    "required": ["a", "b"],
                    "properties": {"a": {"type": "boolean"}, "b": {"type": "boolean"}},
                    "additionalProperties": false,
                  },
                },
                "additionalProperties": false,
              },
            },
          },
          "additionalProperties": false,
        },
        "engine": {
          "type": "object",
          "required": ["name", "version", "build", "backend"],
          "properties": {
            "name": {"type": "string"},
            "version": {"type": ["string", "null"]},
            "build": {"type": ["string", "null"]},
            "backend": {"type": ["string", "null"]},
          },
          "additionalProperties": false,
        },
        "settings": {
          "type": "object",
          "required": ["tolerance", "excludeVoidsAndHosts"],
          "properties": {"tolerance": {"type": "number"}, "excludeVoidsAndHosts": {"type": "boolean"}},
          "additionalProperties": false,
        },
        "coverage": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["rule", "matchedA", "matchedB", "candidatesExamined", "examined"],
            "properties": {
              "rule": {"type": "string"},
              "matchedA": {"type": "integer"},
              "matchedB": {"type": ["integer", "null"]},
              "candidatesExamined": {"type": ["integer", "null"]},
              "examined": {
                "anyOf": [
                  {"type": "null"},
                  {
                    "type": "object",
                    "required": ["a", "b"],
                    "properties": {
                      "a": {
                        "type": "object",
                        "additionalProperties": {"type": "array", "items": {"type": "string"}},
                      },
                      "b": {
                        "anyOf": [
                          {
                            "type": "object",
                            "additionalProperties": {"type": "array", "items": {"type": "string"}},
                          },
                          {"type": "null"},
                        ],
                      },
                    },
                    "additionalProperties": false,
                  },
                ],
              },
            },
            "additionalProperties": false,
          },
        },
        "ambiguousKeys": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}}},
        "exclusions": {"anyOf": [{"type": "array", "items": {"type": "string"}}, {"type": "null"}]},
        "exclusionRules": {
          "type": ["array", "null"],
          "items": {
            "oneOf": [
              {
                "type": "object",
                "required": ["kind", "type"],
                "properties": {"kind": {"const": "type"}, "type": {"type": "string"}},
                "additionalProperties": false,
              },
              {
                "type": "object",
                "required": ["kind", "a", "b"],
                "properties": {"kind": {"const": "typePair"}, "a": {"type": "string"}, "b": {"type": "string"}},
                "additionalProperties": false,
              },
              {
                "type": "object",
                "required": ["kind", "a", "b"],
                "properties": {"kind": {"const": "elementKeyPair"}, "a": {"type": "string"}, "b": {"type": "string"}},
                "additionalProperties": false,
              },
            ],
          },
        },
        "exclusionTypes": {
          "anyOf": [
            {"type": "null"},
            {
              "type": "object",
              "additionalProperties": {"type": "object", "additionalProperties": {"type": "string"}},
            },
          ],
        },
        "truncated": {
          "anyOf": [
            {"type": "null"},
            {
              "type": "object",
              "required": ["reason", "droppedPairs"],
              "properties": {"reason": {"type": "string"}, "droppedPairs": {"type": "integer"}},
              "additionalProperties": false,
            },
          ],
        },
      },
      "additionalProperties": false,
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "key",
          "legacyKey",
          "rule",
          "ruleRevision",
          "status",
          "severity",
          "distance",
          "distanceKind",
          "volume",
          "point",
          "bbox",
          "a",
          "b",
        ],
        "properties": {
          "id": {"type": "string"},
          "key": {"type": ["string", "null"]},
          "legacyKey": {"type": "string"},
          "rule": {"type": "string"},
          "ruleRevision": {"type": "string"},
          "status": {"enum": ["hard", "clearance", "touch"]},
          "severity": {"enum": ["critical", "major", "minor", "info"]},
          "distance": {"type": "number"},
          "distanceKind": {"enum": ["mesh", "estimate", null]},
          "volume": {"type": ["number", "null"]},
          "point": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
          "bbox": {
            "type": "object",
            "required": ["min", "max"],
            "properties": {
              "min": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
              "max": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
            },
            "additionalProperties": false,
          },
          "a": {
            "type": "object",
            "required": ["slot", "key", "globalId", "type"],
            "properties": {
              "slot": {"type": "string"},
              "key": {"type": "string"},
              "globalId": {"type": ["string", "null"]},
              "type": {"type": "string"},
              "name": {"type": "string"},
              "ambiguous": {"const": true},
            },
            "additionalProperties": false,
          },
          "b": {
            "type": "object",
            "required": ["slot", "key", "globalId", "type"],
            "properties": {
              "slot": {"type": "string"},
              "key": {"type": "string"},
              "globalId": {"type": ["string", "null"]},
              "type": {"type": "string"},
              "name": {"type": "string"},
              "ambiguous": {"const": true},
            },
            "additionalProperties": false,
          },
          "review": {
            "type": "object",
            "required": ["status"],
            "properties": {
              "status": {"enum": ["open", "resolved", "accepted"]},
              "comment": {"type": "string"},
              "updatedAt": {"type": "number"},
            },
            "additionalProperties": false,
          },
        },
        "additionalProperties": false,
      },
    },
  },
  "additionalProperties": false,
} as const;
