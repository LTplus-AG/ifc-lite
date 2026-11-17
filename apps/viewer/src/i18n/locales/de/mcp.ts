/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const mcpDe = {
  "mcp.mcpLanding.documentTitle": "@ifc-lite/mcp — IFC mit jedem LLM steuern",
  "mcp.mcpLanding.brand": "ifc-lite",
  "mcp.mcpLanding.navBadge": "/ mcp · {version}",
  "mcp.mcpLanding.navViewer": "Viewer",
  "mcp.mcpLanding.navInstall": "Installieren",
  "mcp.mcpLanding.navRecipes": "Beispiele",
  "mcp.mcpLanding.navTools": "Werkzeuge",
  "mcp.mcpLanding.navPlayground": "Testumgebung",
  "mcp.mcpLanding.heroBadge": "neu · @ifc-lite/mcp v{version}",
  "mcp.mcpLanding.heroTitleLine1": "Ein Gebäude steuern.",
  "mcp.mcpLanding.heroTitleLine2": "Aus einem Chat.",
  "mcp.mcpLanding.heroSubtitle": "{count} typisierte Werkzeuge, mit denen jeder LLM-Agent echte IFC-Gebäudemodelle abfragen, prüfen, ändern und visualisieren kann. Dieselben Werkzeuge, die Ihre Entwickler ausliefern — im Chat.",
  "mcp.mcpLanding.tryInPlayground": "In der Testumgebung ausprobieren",
  "mcp.mcpLanding.installCta": "Installieren",
  "mcp.mcpLanding.statTypedTools": {
    "one": "{countDisplay} typisiertes Werkzeug",
    "other": "{countDisplay} typisierte Werkzeuge"
  },
  "mcp.mcpLanding.statCategories": {
    "one": "{countDisplay} Kategorie",
    "other": "{countDisplay} Kategorien"
  },
  "mcp.mcpLanding.statMcpClients": {
    "one": "{countDisplay} MCP-Client",
    "other": "{countDisplay} MCP-Clients"
  },
  "mcp.mcpLanding.statTransports": {
    "one": "{countDisplay} Transportweg",
    "other": "{countDisplay} Transportwege"
  },
  "mcp.mcpLanding.statTransportsSublabel": "stdio · http",
  "mcp.mcpLanding.scrollHint": "scrollen",
  "mcp.mcpLanding.stepIndicator": "· Schritt {step} / {total}",
  "mcp.mcpLanding.ifcTypeLabel": "Ifc{type}",
  "mcp.mcpLanding.bsddWallBadge": "bSDD · IfcWall",
  "mcp.mcpLanding.psetsCount": "{count} Eigenschaftensätze",
  "mcp.mcpLanding.schemaOnly": "— nur Schema —",
  "mcp.mcpLanding.installSectionTitle": "Wählen Sie Ihren Client. Die Konfiguration liegt bereit.",
  "mcp.mcpLanding.alsoLabel": "auch",
  "mcp.mcpLanding.installInstructionsSr": "Installationsanleitung",
  "mcp.mcpLanding.oneClickBadge": "{index} / ein Klick",
  "mcp.mcpLanding.pasteConfigBadge": "{index} / Konfiguration einfügen",
  "mcp.mcpLanding.manual": "manuell",
  "mcp.mcpLanding.installSlash": "Installation / {name}",
  "mcp.mcpLanding.oneClickOrCopy": "Ein Klick. Oder kopieren.",
  "mcp.mcpLanding.dropInRestart": "Einfügen. Neu starten.",
  "mcp.mcpLanding.openInClient": "In {name} öffnen",
  "mcp.mcpLanding.copied": "Kopiert",
  "mcp.mcpLanding.copy": "Kopieren",
  "mcp.mcpLanding.copyJsonRpc": "JSON-RPC kopieren",
  "mcp.mcpLanding.recipesTitle": "Acht Anfragen für nach der Installation.",
  "mcp.mcpLanding.userLabel": "Nutzer",
  "mcp.mcpLanding.recipesScrollCount": "{count} Beispiele · scrollen →",
  "mcp.mcpLanding.scrollLeft": "Nach links scrollen",
  "mcp.mcpLanding.scrollRight": "Nach rechts scrollen",
  "mcp.mcpLanding.catalogEyebrow": "Katalog",
  "mcp.mcpLanding.catalogTypedTools": "{count} typisierte Werkzeuge.",
  "mcp.mcpLanding.catalogEverything": "Alles, was ein Agent braucht.",
  "mcp.mcpLanding.signature": "Signatur",
  "mcp.mcpLanding.parametersCount": "Parameter · {count}",
  "mcp.mcpLanding.noParameters": "Keine Parameter — mit {token} aufrufen.",
  "mcp.mcpLanding.colName": "Name",
  "mcp.mcpLanding.colType": "Typ",
  "mcp.mcpLanding.colReq": "erf.",
  "mcp.mcpLanding.colDescription": "Beschreibung",
  "mcp.mcpLanding.yes": "ja",
  "mcp.mcpLanding.exampleCall": "Beispielaufruf",
  "mcp.mcpLanding.toolShareLink": "# {name} · Link teilen",
  "mcp.mcpLanding.bringYourModel": "Bringen Sie Ihr Modell mit.",
  "mcp.mcpLanding.weBroughtTools": "Die Werkzeuge haben wir.",
  "mcp.mcpLanding.openPlayground": "Testumgebung öffnen",
  "mcp.mcpLanding.footerBrand": "ifc-lite/mcp · v{version} · MPL-2.0",
  "mcp.mcpLanding.darkByIntent": "Bewusst dunkel.",
  "mcp.mcpLanding.footerColSource": "Quellcode",
  "mcp.mcpLanding.footerColDocs": "Dokumentation",
  "mcp.mcpLanding.footerColSpec": "Spezifikation",
  "mcp.heroScene.webglUnavailable": "3D-Vorschau auf diesem Gerät nicht verfügbar",
  "mcp.playgroundViewer.webglUnavailableTitle": "3D-Vorschau auf diesem Gerät nicht verfügbar",
  "mcp.playgroundViewer.webglUnavailableBody": "Ihr Browser konnte keine Grafik für den Viewer bereitstellen. Laden, Abfragen und alle anderen Werkzeuge funktionieren weiterhin.",
  "mcp.playgroundDispatcher.webglUnavailable": "Dieses Gerät kann keinen WebGL-Kontext bereitstellen, daher wird der eingebettete 3D-Viewer nicht gestartet. Alle viewer_*-Werkzeuge sind für den Rest dieser Sitzung nicht verfügbar. Einlesen, Abfragen, Prüfungen, BCF und Export sind nicht betroffen.",
  "mcp.playgroundDispatcher.webglUnavailableHint": "Antworten Sie mit Werkzeugen ohne Viewer; kein 3D-Werkzeug kann auf diesem Gerät erfolgreich sein.",
  "mcp.playgroundViewer.meshCount": {
    "one": "{count} Netz",
    "other": "{count} Netze"
  },
  "mcp.playgroundViewer.preparing": "wird vorbereitet…",
  "mcp.playgroundViewer.loadModelFirst": "zuerst ein Modell laden",
  "mcp.playgroundViewer.bootingPipeline": "Geometrieverarbeitung wird gestartet…",
  "mcp.playgroundViewer.extractingGeometry": "Geometrie wird extrahiert…",
  "mcp.playgroundViewer.noDrawableGeometry": "Keine darstellbare Geometrie — das Modell enthält möglicherweise nur das Schema."
} satisfies Catalogue;
