#!/usr/bin/env bash
# ============================================================================
# ifc-lite 3D Viewer & Analysis Demo
# ============================================================================
# Model: AC20-FZK-Haus.ifc (IFC4, 2.4 MB, 44k entities, 2 storeys)
#
# Usage:
#   chmod +x demo/viewer-demo.sh
#   ./demo/viewer-demo.sh
#
# Requirements:
#   npm i -g @ifc-lite/cli    (or use: npx @ifc-lite/cli)
#
# The demo walks through 8 scenes interactively. Press Enter to advance.
# ============================================================================

set -euo pipefail

MODEL="tests/models/ara3d/AC20-FZK-Haus.ifc"
PORT=3456
CLI=(pnpm exec ifc-lite)   # change to (ifc-lite) or (npx @ifc-lite/cli) if installed globally

# ---------- helpers ----------------------------------------------------------

BOLD="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
YELLOW="\033[33m"
GREEN="\033[32m"
RESET="\033[0m"

banner() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${CYAN}  $1${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

step() {
  echo ""
  echo -e "${YELLOW}▸ $1${RESET}"
  echo -e "${DIM}  $2${RESET}"
}

run() {
  echo ""
  echo -e "${GREEN}\$ $*${RESET}"
  "$@"
}

pause() {
  echo ""
  echo -e "${DIM}  ⏎ Press Enter to continue...${RESET}"
  read -r
}

send() {
  # Send a command to the running viewer via REST API
  curl -s -X POST "http://127.0.0.1:${PORT}/api/command" \
    -H 'Content-Type: application/json' \
    -d "$1" | jq -r '.ok // .error' 2>/dev/null || true
}

# ---------- pre-flight -------------------------------------------------------

if [ ! -f "$MODEL" ]; then
  echo "Error: $MODEL not found. Run from the ifc-lite repo root."
  exit 1
fi

# Kill any existing viewer on our port
lsof -ti :"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true

# ============================================================================
# SCENE 1 — Model overview (no viewer needed)
# ============================================================================
banner "Scene 1: Instant Model Insight"

step "Model summary" "Schema, storeys, element counts — parsed in milliseconds"
run "${CLI[@]}" info "$MODEL"

pause

step "Query walls with quantities" "Filter by type, show dimensions"
run "${CLI[@]}" query "$MODEL" --type IfcWallStandardCase --quantities --limit 5

pause

# ============================================================================
# SCENE 2 — Launch 3D viewer
# ============================================================================
banner "Scene 2: Launch 3D Viewer"

step "Start interactive viewer" "Opens browser with WebGL 2 renderer"
echo ""
echo -e "${GREEN}\$ ${CLI[*]} view $MODEL --port $PORT &${RESET}"
"${CLI[@]}" view "$MODEL" --port "$PORT" &
VIEWER_PID=$!

# Wait for the server to be ready
echo -e "${DIM}  Waiting for viewer to start...${RESET}"
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo -e "${GREEN}  ✓ Viewer running at http://127.0.0.1:${PORT}${RESET}"

pause

# ============================================================================
# SCENE 3 — Colorize, isolate, xray
# ============================================================================
banner "Scene 3: Visual Querying"

step "Colorize all walls red" "Highlights structural elements"
echo -e "${GREEN}\$ curl → colorize IfcWallStandardCase red${RESET}"
send '{"action":"colorize","type":"IfcWallStandardCase","color":"red"}'
sleep 1

step "Colorize windows blue" "Distinguish element types visually"
echo -e "${GREEN}\$ curl → colorize IfcWindow blue${RESET}"
send '{"action":"colorize","type":"IfcWindow","color":"blue"}'
sleep 1

step "Colorize doors green" ""
echo -e "${GREEN}\$ curl → colorize IfcDoor green${RESET}"
send '{"action":"colorize","type":"IfcDoor","color":"green"}'

pause

step "X-ray slabs" "Make floors semi-transparent to see interior"
echo -e "${GREEN}\$ curl → xray IfcSlab 0.15${RESET}"
send '{"action":"xray","type":"IfcSlab","opacity":0.15}'

pause

step "Isolate walls + doors only" "Hide everything else"
echo -e "${GREEN}\$ curl → isolate [IfcWallStandardCase, IfcDoor]${RESET}"
send '{"action":"isolate","types":["IfcWallStandardCase","IfcDoor"]}'

pause

step "Show all again" "Reset visibility"
echo -e "${GREEN}\$ curl → showall${RESET}"
send '{"action":"showall"}'
send '{"action":"reset"}'

pause

# ============================================================================
# SCENE 4 — Camera + section planes
# ============================================================================
banner "Scene 4: Camera & Section Planes"

step "Fly to doors" "Auto-zoom to element type"
echo -e "${GREEN}\$ curl → flyto IfcDoor${RESET}"
send '{"action":"flyto","type":"IfcDoor"}'
sleep 2

step "Isometric view" "Standard camera preset"
echo -e "${GREEN}\$ curl → setView iso${RESET}"
send '{"action":"setView","view":"iso"}'
sleep 1

step "Front view" ""
echo -e "${GREEN}\$ curl → setView front${RESET}"
send '{"action":"setView","view":"front"}'
sleep 1

pause

step "Horizontal section plane" "Cut through the building at mid-height"
echo -e "${GREEN}\$ curl → section y center${RESET}"
send '{"action":"section","axis":"y","position":"center"}'

pause

step "Move section to 30%" "See more of the ground floor"
echo -e "${GREEN}\$ curl → section y 30%${RESET}"
send '{"action":"section","axis":"y","position":"30%"}'

pause

step "Clear section" ""
echo -e "${GREEN}\$ curl → clearSection${RESET}"
send '{"action":"clearSection"}'
send '{"action":"setView","view":"iso"}'

pause

# ============================================================================
# SCENE 5 — Color by storey
# ============================================================================
banner "Scene 5: Storey Analysis"

step "Color by building storey" "Auto-assigns colors by elevation (Erdgeschoss / Dachgeschoss)"
echo -e "${GREEN}\$ curl → colorByStorey${RESET}"
send '{"action":"colorByStorey"}'

pause

send '{"action":"reset"}'

# ============================================================================
# SCENE 6 — Analyze command (property-based visual analysis)
# ============================================================================
banner "Scene 6: Property Analysis (analyze command)"

step "Find walls missing FireRating" "Walls have ThermalTransmittance but no FireRating — flag them red"
run "${CLI[@]}" analyze "$MODEL" --viewer "$PORT" \
  --type IfcWallStandardCase \
  --missing "Pset_WallCommon.FireRating" \
  --color red --isolate --flyto

pause

step "Reset and show all" ""
send '{"action":"reset"}'
send '{"action":"showall"}'
sleep 1

step "Heatmap: wall area" "Color walls by GrossSideArea — blue (small) to red (large)"
run "${CLI[@]}" analyze "$MODEL" --viewer "$PORT" \
  --type IfcWallStandardCase \
  --heatmap "BaseQuantities.GrossSideArea" \
  --palette blue-red

pause

step "Reset" ""
send '{"action":"reset"}'
send '{"action":"showall"}'
sleep 1

step "Filter by property value" "Find walls with area > 12 m²"
run "${CLI[@]}" analyze "$MODEL" --viewer "$PORT" \
  --type IfcWallStandardCase \
  --where "BaseQuantities.GrossSideArea>12" \
  --color orange --isolate --flyto

pause

send '{"action":"reset"}'
send '{"action":"showall"}'

# ============================================================================
# SCENE 7 — Batch rules from JSON
# ============================================================================
banner "Scene 7: Batch Analysis Rules"

step "Create rules file" "Multiple analysis rules in one shot"

RULES_FILE=$(mktemp /tmp/demo-rules-XXXXXX.json)
cat > "$RULES_FILE" << 'RULES'
[
  {
    "name": "Missing fire rating",
    "type": "IfcWallStandardCase",
    "missing": "Pset_WallCommon.FireRating",
    "color": "red"
  },
  {
    "name": "Large wall area (>12 m²)",
    "type": "IfcWallStandardCase",
    "where": "BaseQuantities.GrossSideArea>12",
    "color": "orange"
  },
  {
    "name": "Doors highlighted",
    "type": "IfcDoor",
    "color": "green"
  }
]
RULES

echo -e "${DIM}  Rules file:${RESET}"
cat "$RULES_FILE" | jq .
echo ""

run "${CLI[@]}" analyze "$MODEL" --viewer "$PORT" --rules "$RULES_FILE" --json

rm -f "$RULES_FILE"

pause

# ============================================================================
# SCENE 8 — Live element creation
# ============================================================================
banner "Scene 8: Live Element Creation"

send '{"action":"reset"}'
send '{"action":"showall"}'

step "Create a wall in real-time" "Injected directly into the running viewer"
echo -e "${GREEN}\$ curl → /api/create wall${RESET}"
curl -s -X POST "http://127.0.0.1:${PORT}/api/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "wall",
    "params": {
      "Height": 3,
      "Thickness": 0.3,
      "Start": [15, 0, 0],
      "End": [20, 0, 0],
      "Color": [1, 0.3, 0.1]
    }
  }' | jq .

pause

step "Create a column" ""
echo -e "${GREEN}\$ curl → /api/create column${RESET}"
curl -s -X POST "http://127.0.0.1:${PORT}/api/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "column",
    "params": {
      "Height": 3,
      "Position": [15, 0, 0],
      "Color": [0.2, 0.6, 1.0]
    }
  }' | jq .

pause

step "Export created geometry as IFC" ""
echo -e "${GREEN}\$ curl http://127.0.0.1:${PORT}/api/export > demo-created.ifc${RESET}"
curl -s "http://127.0.0.1:${PORT}/api/export" > /tmp/demo-created.ifc
echo -e "${GREEN}  ✓ Saved to /tmp/demo-created.ifc ($(wc -c < /tmp/demo-created.ifc) bytes)${RESET}"

step "Clear created geometry" ""
echo -e "${GREEN}\$ curl → /api/clear-created${RESET}"
curl -s -X POST "http://127.0.0.1:${PORT}/api/clear-created" | jq .

pause

# ============================================================================
# DONE
# ============================================================================
banner "Demo Complete"

echo ""
echo -e "  Viewer still running at ${BOLD}http://127.0.0.1:${PORT}${RESET}"
echo -e "  Try interactive commands in the viewer terminal:"
echo -e "    ${GREEN}colorize IfcWall red${RESET}"
echo -e "    ${GREEN}xray IfcSlab 0.15${RESET}"
echo -e "    ${GREEN}storey${RESET}"
echo -e "    ${GREEN}section y center${RESET}"
echo -e "    ${GREEN}quit${RESET}"
echo ""
echo -e "${DIM}  Kill viewer: kill $VIEWER_PID${RESET}"
echo ""

# Hand control back to the viewer's interactive stdin
wait $VIEWER_PID 2>/dev/null || true
