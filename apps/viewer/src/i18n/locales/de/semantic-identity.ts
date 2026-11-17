/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticIdentityDe = {
  "semantic.identityControls": "IFC-Identitätsstrategie",
  "semantic.identityUri": "Der Ressourcen-URI enthält IFC GlobalId",
  "semantic.identityUriMode": "Ressourcen-URI-Abgleich",
  "semantic.identityUriTemplateMode": "Vollständige URI-Vorlage",
  "semantic.identityUriSegmentMode": "Letztes Pfadsegment (Opt-in)",
  "semantic.identityUriTemplate": "Vollständige Ressourcen-URI-Vorlage",
  "semantic.identityUriApply": "URI-Vorlage anwenden",
  "semantic.identityUriHint": "Die Vorlage verwendet einen {GlobalId}-Platzhalter. Das letzte Pfadsegment benötigt bekannte Ressourcen-URIs für umgekehrte Abfragen. Der URI-Abgleich ersetzt niemals die ausgewählte direkte GlobalId-Strategie.",
  "semantic.identityDirect": "IFC GlobalId und Modellrevision",
  "semantic.identityLinks": "Explizite Ressourcenlinks",
  "semantic.identityProfile": "Profilidentitätsfelder",
  "semantic.identityGuidField": "Profilfeld GlobalId",
  "semantic.identityRevisionField": "Feld für die Profilrevision",
  "semantic.identityNoRevision": "Kein Revisionsfeld",
  "semantic.identityLinkJson": "Ressourcenlinks (JSON)",
  "semantic.identityApplyLinks": "Wenden Sie Ressourcenlinks an",
  "semantic.identityLinkHint": "Verwenden Sie resourceId, modelRevision und GlobalId. Modellrevisionen benötigen eine explizite Zuordnung zu einem geladenen Modell.",
} satisfies Catalogue;
