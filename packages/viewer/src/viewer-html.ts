/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Self-contained WebGL 2 viewer HTML template for the CLI `view` command.
 *
 * Features:
 *   - Progressive geometry streaming via @ifc-lite/wasm
 *   - Edge-enhanced rendering (dFdx/dFdy normal discontinuity detection)
 *   - Ground grid with distance fade
 *   - Section plane clipping
 *   - Orbit camera with smooth inertia
 *   - Entity picking (GPU color-ID pass)
 *   - Live geometry addition (addGeometry command)
 *   - Full command API: colorize, isolate, xray, highlight, section, etc.
 *
 * Communication:
 *   CLI → Browser:  Server-Sent Events on /events
 *   Browser → CLI:  POST /api/command
 */

export function getViewerHtml(modelName: string): string {
  // Escape HTML special characters to prevent injection via crafted filenames
  const safe = modelName
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safe} — ifc-lite 3D</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1a1a2e}
canvas{display:block;width:100%;height:100%;cursor:grab}
canvas:active{cursor:grabbing}
#overlay{position:absolute;top:0;left:0;right:0;pointer-events:none;padding:12px 16px;display:flex;justify-content:space-between;align-items:flex-start}
#info{color:#e0e0e0;font-size:13px;background:rgba(20,20,40,0.85);padding:8px 14px;border-radius:8px;backdrop-filter:blur(8px);pointer-events:auto}
#info h2{font-size:14px;font-weight:600;margin-bottom:2px;color:#fff}
#info span{opacity:0.7;font-size:12px}
#status{color:#e0e0e0;font-size:12px;background:rgba(20,20,40,0.85);padding:8px 14px;border-radius:8px;backdrop-filter:blur(8px);text-align:right;pointer-events:auto}
#progress-wrap{position:absolute;bottom:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.1)}
#progress-bar{height:100%;width:0%;background:linear-gradient(90deg,#4f8cff,#a855f7);transition:width 0.2s}
#pick-info{position:absolute;bottom:16px;left:16px;color:#fff;font-size:12px;background:rgba(20,20,40,0.9);padding:10px 14px;border-radius:8px;backdrop-filter:blur(8px);display:none;max-width:350px;pointer-events:auto}
#pick-info .label{opacity:0.6;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
#pick-info .value{font-weight:500;margin-bottom:4px}
#cmd-log{position:absolute;bottom:16px;right:16px;color:#a0f0a0;font-size:11px;background:rgba(20,20,40,0.9);padding:8px 12px;border-radius:8px;display:none;pointer-events:auto;max-width:320px;font-family:monospace}
.loading-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a1a2e;color:#fff;z-index:10}
.loading-screen h1{font-size:24px;font-weight:300;margin-bottom:8px}
.loading-screen p{font-size:14px;opacity:0.6}
.spinner{width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#4f8cff;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="loading" class="loading-screen">
  <div class="spinner"></div>
  <h1>Loading ${safe}</h1>
  <p id="loading-text">Initializing WASM engine...</p>
</div>
<canvas id="c" tabindex="0"></canvas>
<div id="overlay">
  <div id="info"><h2>${safe}</h2><span id="model-stats">Loading...</span></div>
  <div id="status"><span id="fps"></span></div>
</div>
<div id="progress-wrap"><div id="progress-bar"></div></div>
<div id="pick-info"></div>
<div id="cmd-log"></div>

<script type="module">
// ═══════════════════════════════════════════════════════════════════
// 1. MATH UTILITIES
// ═══════════════════════════════════════════════════════════════════
const mat4 = {
  create() { const m = new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; },
  perspective(fov, aspect, near, far) {
    const f = 1/Math.tan(fov/2), nf = 1/(near-far), m = new Float32Array(16);
    m[0]=f/aspect; m[5]=f; m[10]=(far+near)*nf; m[11]=-1; m[14]=2*far*near*nf;
    return m;
  },
  lookAt(eye, center, up) {
    const m = new Float32Array(16);
    let zx=eye[0]-center[0], zy=eye[1]-center[1], zz=eye[2]-center[2];
    let len = 1/Math.sqrt(zx*zx+zy*zy+zz*zz+1e-10); zx*=len; zy*=len; zz*=len;
    let xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
    len = Math.sqrt(xx*xx+xy*xy+xz*xz);
    if(len>1e-10){len=1/len; xx*=len; xy*=len; xz*=len;}
    let yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
    m[0]=xx;m[1]=yx;m[2]=zx;m[4]=xy;m[5]=yy;m[6]=zy;m[8]=xz;m[9]=yz;m[10]=zz;
    m[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
    m[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
    m[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
    m[15]=1;
    return m;
  },
  multiply(a, b) {
    const m = new Float32Array(16);
    for(let i=0;i<4;i++) for(let j=0;j<4;j++){
      m[j*4+i]=a[i]*b[j*4]+a[4+i]*b[j*4+1]+a[8+i]*b[j*4+2]+a[12+i]*b[j*4+3];
    }
    return m;
  },
  invert(a) {
    const m = new Float32Array(16);
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7];
    const a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10;
    const b03=a01*a12-a02*a11,b04=a01*a13-a03*a11,b05=a02*a13-a03*a12;
    const b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,b08=a20*a33-a23*a30;
    const b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if(Math.abs(det)<1e-10) return m;
    det=1/det;
    m[0]=(a11*b11-a12*b10+a13*b09)*det; m[1]=(a02*b10-a01*b11-a03*b09)*det;
    m[2]=(a31*b05-a32*b04+a33*b03)*det; m[3]=(a22*b04-a21*b05-a23*b03)*det;
    m[4]=(a12*b08-a10*b11-a13*b07)*det; m[5]=(a00*b11-a02*b08+a03*b07)*det;
    m[6]=(a32*b02-a30*b05-a33*b01)*det; m[7]=(a20*b05-a22*b02+a23*b01)*det;
    m[8]=(a10*b10-a11*b08+a13*b06)*det; m[9]=(a01*b08-a00*b10-a03*b06)*det;
    m[10]=(a30*b04-a31*b02+a33*b00)*det; m[11]=(a21*b02-a20*b04-a23*b00)*det;
    m[12]=(a11*b07-a10*b09-a12*b06)*det; m[13]=(a00*b09-a01*b07+a02*b06)*det;
    m[14]=(a31*b01-a30*b03-a32*b00)*det; m[15]=(a20*b03-a21*b01+a22*b00)*det;
    return m;
  },
  transpose(a) {
    const m = new Float32Array(16);
    m[0]=a[0];m[1]=a[4];m[2]=a[8];m[3]=a[12];
    m[4]=a[1];m[5]=a[5];m[6]=a[9];m[7]=a[13];
    m[8]=a[2];m[9]=a[6];m[10]=a[10];m[11]=a[14];
    m[12]=a[3];m[13]=a[7];m[14]=a[11];m[15]=a[15];
    return m;
  },
};

// ═══════════════════════════════════════════════════════════════════
// 2. WEBGL SETUP
// ═══════════════════════════════════════════════════════════════════
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
if (!gl) { document.getElementById('loading-text').textContent = 'WebGL 2 not supported'; throw new Error('No WebGL2'); }

function resize() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
}
window.addEventListener('resize', resize);
resize();

// ── Main shader with edge detection + section plane ──
const VS = \`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNorm;
layout(location=2) in vec4 aCol;
uniform mat4 uMVP;
uniform mat4 uNormMat;
out vec3 vNorm;
out vec4 vCol;
out vec3 vWorldPos;
void main(){
  gl_Position = uMVP * vec4(aPos, 1.0);
  vNorm = mat3(uNormMat) * aNorm;
  vCol = aCol;
  vWorldPos = aPos;
}\`;

const FS = \`#version 300 es
precision highp float;
in vec3 vNorm;
in vec4 vCol;
in vec3 vWorldPos;
uniform vec4 uSectionPlane;
uniform int uSectionEnabled;
uniform float uEdgeStrength;
out vec4 fragColor;
void main(){
  // Section plane clipping
  if(uSectionEnabled == 1){
    if(dot(vWorldPos, uSectionPlane.xyz) > uSectionPlane.w) discard;
  }
  if(vCol.a < 0.01) discard;
  vec3 n = normalize(vNorm);

  // Three-point lighting for architectural quality
  vec3 keyDir = normalize(vec3(0.4, 0.9, 0.3));
  vec3 fillDir = normalize(vec3(-0.6, 0.3, -0.4));
  vec3 rimDir = normalize(vec3(0.0, -0.5, -0.8));
  float key = abs(dot(n, keyDir)) * 0.55;
  float fill = abs(dot(n, fillDir)) * 0.25;
  float rim = pow(max(0.0, 1.0 - abs(dot(n, rimDir))), 3.0) * 0.15;
  float ambient = 0.28;
  float light = ambient + key + fill + rim;

  // Edge detection via normal discontinuity (dFdx/dFdy)
  vec3 ndx = dFdx(vNorm);
  vec3 ndy = dFdy(vNorm);
  float edgeFactor = length(ndx) + length(ndy);
  float edge = smoothstep(0.1, 0.6, edgeFactor * uEdgeStrength);

  vec3 litColor = vCol.rgb * min(light, 1.0);
  // Darken edges for architectural line effect
  litColor = mix(litColor, litColor * 0.35, edge * 0.7);

  fragColor = vec4(litColor, vCol.a);
}\`;

// ── Grid shader ──
const GRID_VS = \`#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat4 uMVP;
uniform float uGridY;
uniform float uGridExtent;
out vec3 vWorldPos;
void main(){
  vec3 wp = vec3(aPos.x * uGridExtent, uGridY, aPos.y * uGridExtent);
  gl_Position = uMVP * vec4(wp, 1.0);
  vWorldPos = wp;
}\`;

const GRID_FS = \`#version 300 es
precision highp float;
in vec3 vWorldPos;
uniform float uGridScale;
uniform float uGridExtent;
out vec4 fragColor;
void main(){
  vec2 coord = vWorldPos.xz / uGridScale;
  vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  float line = min(grid.x, grid.y);
  float alpha = 1.0 - min(line, 1.0);
  // Major grid lines
  vec2 coordMajor = vWorldPos.xz / (uGridScale * 5.0);
  vec2 gridMajor = abs(fract(coordMajor - 0.5) - 0.5) / fwidth(coordMajor);
  float lineMajor = min(gridMajor.x, gridMajor.y);
  float alphaMajor = 1.0 - min(lineMajor, 1.0);
  alpha = max(alpha * 0.15, alphaMajor * 0.3);
  // Distance fade
  float dist = length(vWorldPos.xz);
  alpha *= smoothstep(uGridExtent, uGridExtent * 0.3, dist);
  if(alpha < 0.005) discard;
  fragColor = vec4(0.5, 0.5, 0.6, alpha);
}\`;

// ── Pick shader (encodes expressId per vertex, uploaded once) ──
const PICK_VS2 = \`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aPickCol;
uniform mat4 uMVP;
flat out vec4 vPickCol;
void main(){
  gl_Position = uMVP * vec4(aPos, 1.0);
  vPickCol = aPickCol;
}\`;

const PICK_FS2 = \`#version 300 es
precision highp float;
flat in vec4 vPickCol;
out vec4 fragColor;
void main(){
  fragColor = vPickCol;
}\`;

function compileShader(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function createProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(vs, gl.VERTEX_SHADER));
  gl.attachShader(p, compileShader(fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('Program error:', gl.getProgramInfoLog(p));
  }
  return p;
}

// Main program
const prog = createProgram(VS, FS);
const uMVP = gl.getUniformLocation(prog, 'uMVP');
const uNormMat = gl.getUniformLocation(prog, 'uNormMat');
const uSectionPlane = gl.getUniformLocation(prog, 'uSectionPlane');
const uSectionEnabled = gl.getUniformLocation(prog, 'uSectionEnabled');
const uEdgeStrength = gl.getUniformLocation(prog, 'uEdgeStrength');

// Grid program
const gridProg = createProgram(GRID_VS, GRID_FS);
const gMVP = gl.getUniformLocation(gridProg, 'uMVP');
const gGridY = gl.getUniformLocation(gridProg, 'uGridY');
const gGridScale = gl.getUniformLocation(gridProg, 'uGridScale');
const gGridExtent = gl.getUniformLocation(gridProg, 'uGridExtent');

// Pick program (uses per-vertex entity ID colors, uploaded once)
const pickProg = createProgram(PICK_VS2, PICK_FS2);
const pMVP = gl.getUniformLocation(pickProg, 'uMVP');

// Grid geometry (unit quad)
const gridVao = gl.createVertexArray();
gl.bindVertexArray(gridVao);
const gridBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// Section plane state
let sectionEnabled = false;
let sectionPlane = [0, 1, 0, 0]; // normal xyz, distance w

// ═══════════════════════════════════════════════════════════════════
// 3. SCENE STATE
// ═══════════════════════════════════════════════════════════════════

// Entity tracking: expressId -> { segments[], defaultColor, ifcType, boundsMin, boundsMax }
const entityMap = new Map();
// Merged geometry buffers
let positions = [];   // Float32Array segments
let normals = [];
let indices = [];
let colors = [];      // Per-vertex RGBA
let pickColors = [];  // Per-vertex entity-ID encoding (uploaded once)
let totalVertices = 0;
let totalIndices = 0;
let totalTriangles = 0;

// WebGL buffers
let vao = null;
let posBuffer = null;
let normBuffer = null;
let colBuffer = null;
let idxBuffer = null;
let pickVao = null;    // Separate VAO for pick pass
let pickColBuffer = null;
let drawCount = 0;

// Model bounds
let boundsMin = [Infinity, Infinity, Infinity];
let boundsMax = [-Infinity, -Infinity, -Infinity];

// Type summary
const typeCounts = new Map();

// WASM API reference (for addGeometry)
let wasmApi = null;

// Federated ID tracking — each addGeometry call gets its own ID namespace
// to avoid collisions between separately-loaded IFC fragments
let nextIdNamespace = 0;       // Increments per addGeometry call
const ID_NAMESPACE_SIZE = 100000; // IDs per namespace

// Track entity IDs added via addGeometry (for removeCreated)
const createdEntityIds = new Set();

function updateBounds(pos) {
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i+1], z = pos[i+2];
    if (x < boundsMin[0]) boundsMin[0] = x;
    if (y < boundsMin[1]) boundsMin[1] = y;
    if (z < boundsMin[2]) boundsMin[2] = z;
    if (x > boundsMax[0]) boundsMax[0] = x;
    if (y > boundsMax[1]) boundsMax[1] = y;
    if (z > boundsMax[2]) boundsMax[2] = z;
  }
}

function computeEntityBounds(posArr, startVert, vertCount) {
  const bMin = [Infinity, Infinity, Infinity], bMax = [-Infinity, -Infinity, -Infinity];
  const base = startVert * 3;
  for (let i = 0; i < vertCount * 3; i += 3) {
    const x = posArr[base+i], y = posArr[base+i+1], z = posArr[base+i+2];
    if (x < bMin[0]) bMin[0] = x; if (y < bMin[1]) bMin[1] = y; if (z < bMin[2]) bMin[2] = z;
    if (x > bMax[0]) bMax[0] = x; if (y > bMax[1]) bMax[1] = y; if (z > bMax[2]) bMax[2] = z;
  }
  return { min: bMin, max: bMax };
}

function addMeshBatch(meshes) {
  const prevVerts = totalVertices;
  const prevIndices = totalIndices;
  for (const mesh of meshes) {
    const vStart = totalVertices;
    const vCount = mesh.positions.length / 3;
    const iStart = totalIndices;
    const iCount = mesh.indices.length;
    const ifcType = mesh.ifcType || 'Unknown';

    // Entity bounds from this mesh
    const meshBounds = computeEntityBounds(mesh.positions, 0, vCount);

    // Track entity
    const existing = entityMap.get(mesh.expressId);
    if (!existing) {
      entityMap.set(mesh.expressId, {
        vertexCount: vCount, indexCount: iCount,
        defaultColor: [...mesh.color], ifcType,
        segments: [{ vertexStart: vStart, vertexCount: vCount, indexStart: iStart, indexCount: iCount }],
        boundsMin: meshBounds.min, boundsMax: meshBounds.max,
      });
    } else {
      existing.segments.push({ vertexStart: vStart, vertexCount: vCount, indexStart: iStart, indexCount: iCount });
      existing.vertexCount += vCount;
      existing.indexCount += iCount;
      // Expand entity bounds
      for (let k = 0; k < 3; k++) {
        existing.boundsMin[k] = Math.min(existing.boundsMin[k], meshBounds.min[k]);
        existing.boundsMax[k] = Math.max(existing.boundsMax[k], meshBounds.max[k]);
      }
    }

    typeCounts.set(ifcType, (typeCounts.get(ifcType) || 0) + 1);

    positions.push(mesh.positions);
    normals.push(mesh.normals);

    // Offset indices
    const offsetIndices = new Uint32Array(iCount);
    for (let i = 0; i < iCount; i++) offsetIndices[i] = mesh.indices[i] + vStart;
    indices.push(offsetIndices);

    // Per-vertex colors
    const vc = new Float32Array(vCount * 4);
    for (let i = 0; i < vCount; i++) {
      vc[i*4] = mesh.color[0]; vc[i*4+1] = mesh.color[1];
      vc[i*4+2] = mesh.color[2]; vc[i*4+3] = mesh.color[3];
    }
    colors.push(vc);

    // Per-vertex pick color (entity ID encoded as RGB, uploaded once)
    const pc = new Float32Array(vCount * 4);
    const pr = ((mesh.expressId >> 16) & 255) / 255;
    const pg = ((mesh.expressId >> 8) & 255) / 255;
    const pb = (mesh.expressId & 255) / 255;
    for (let i = 0; i < vCount; i++) {
      pc[i*4] = pr; pc[i*4+1] = pg; pc[i*4+2] = pb; pc[i*4+3] = 1;
    }
    pickColors.push(pc);

    updateBounds(mesh.positions);
    totalVertices += vCount;
    totalIndices += iCount;
    totalTriangles += iCount / 3;
  }
  uploadGeometry(prevVerts, prevIndices);
}

// GPU buffer capacity tracking for append-only uploads
let gpuCapVerts = 0;
let gpuCapIndices = 0;

function uploadGeometry(prevVerts = 0, prevIndices = 0) {
  const needsRebuild = !vao || totalVertices > gpuCapVerts || totalIndices > gpuCapIndices;

  if (needsRebuild) {
    // Allocate with 2x headroom to reduce future rebuilds
    gpuCapVerts = Math.max(totalVertices * 2, 65536);
    gpuCapIndices = Math.max(totalIndices * 2, 196608);

    if (!vao) {
      vao = gl.createVertexArray();
      posBuffer = gl.createBuffer();
      normBuffer = gl.createBuffer();
      colBuffer = gl.createBuffer();
      idxBuffer = gl.createBuffer();
      pickVao = gl.createVertexArray();
      pickColBuffer = gl.createBuffer();
    }

    // Full re-upload: merge all arrays and allocate new GPU buffers
    const allPos = mergeFloat32(positions, totalVertices * 3);
    const allNorm = mergeFloat32(normals, totalVertices * 3);
    const allCol = mergeFloat32(colors, totalVertices * 4);
    const allPick = mergeFloat32(pickColors, totalVertices * 4);
    const allIdx = mergeUint32(indices, totalIndices);

    // Main render VAO
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, gpuCapVerts * 3 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, allPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, normBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, gpuCapVerts * 3 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, allNorm);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, gpuCapVerts * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, allCol);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, gpuCapIndices * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, allIdx);

    gl.bindVertexArray(null);

    // Pick VAO
    gl.bindVertexArray(pickVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, pickColBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, gpuCapVerts * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, allPick);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
    gl.bindVertexArray(null);
  } else if (prevVerts < totalVertices) {
    // Append-only: just upload the new data at the end of existing buffers
    const newPos = mergeFloat32(positions.slice(getChunkIndex(prevVerts)), (totalVertices - prevVerts) * 3);
    const newNorm = mergeFloat32(normals.slice(getChunkIndex(prevVerts)), (totalVertices - prevVerts) * 3);
    const newCol = mergeFloat32(colors.slice(getChunkIndex(prevVerts)), (totalVertices - prevVerts) * 4);
    const newPick = mergeFloat32(pickColors.slice(getChunkIndex(prevVerts)), (totalVertices - prevVerts) * 4);
    const newIdx = mergeUint32(indices.slice(getChunkIndex(prevIndices, true)), totalIndices - prevIndices);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, prevVerts * 3 * 4, newPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, prevVerts * 3 * 4, newNorm);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, prevVerts * 4 * 4, newCol);
    gl.bindBuffer(gl.ARRAY_BUFFER, pickColBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, prevVerts * 4 * 4, newPick);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, prevIndices * 4, newIdx);
  }
  drawCount = totalIndices;
}

// Map a vertex/index count to the corresponding chunk array index
function getChunkIndex(targetCount, isIndices = false) {
  let count = 0;
  const arr = isIndices ? indices : positions;
  const divisor = isIndices ? 1 : 3;
  for (let i = 0; i < arr.length; i++) {
    count += arr[i].length / divisor;
    if (count >= targetCount) return i;
  }
  return arr.length;
}

function mergeFloat32(arrays, totalLen) {
  const m = new Float32Array(totalLen);
  let off = 0;
  for (const a of arrays) { m.set(a, off); off += a.length; }
  return m;
}
function mergeUint32(arrays, totalLen) {
  const m = new Uint32Array(totalLen);
  let off = 0;
  for (const a of arrays) { m.set(a, off); off += a.length; }
  return m;
}

// ═══════════════════════════════════════════════════════════════════
// 4. CAMERA WITH INERTIA
// ═══════════════════════════════════════════════════════════════════
let camTheta = Math.PI * 0.25;
let camPhi = Math.PI * 0.3;
let camDist = 50;
let camTarget = [0, 0, 0];
// Smooth orbit targets — mouse input writes here, render loop lerps toward them
let camThetaTarget = camTheta;
let camPhiTarget = camPhi;
const ORBIT_SMOOTHING = 0.35; // lerp factor per frame (higher = snappier)
// Inertia
let camVelTheta = 0, camVelPhi = 0;
let camVelPanX = 0, camVelPanY = 0, camVelPanZ = 0;
const FRICTION = 0.88;
// Animation
let camAnimating = false;
let camAnimStart, camAnimDuration, camAnimFrom, camAnimTo;

function getCamPos() {
  const sp = Math.sin(camPhi), cp = Math.cos(camPhi);
  const st = Math.sin(camTheta), ct = Math.cos(camTheta);
  return [
    camTarget[0] + camDist * sp * ct,
    camTarget[1] + camDist * cp,
    camTarget[2] + camDist * sp * st,
  ];
}

function fitCamera() {
  const cx = (boundsMin[0] + boundsMax[0]) / 2;
  const cy = (boundsMin[1] + boundsMax[1]) / 2;
  const cz = (boundsMin[2] + boundsMax[2]) / 2;
  const dx = boundsMax[0] - boundsMin[0];
  const dy = boundsMax[1] - boundsMin[1];
  const dz = boundsMax[2] - boundsMin[2];
  const maxDim = Math.max(dx, dy, dz, 0.1);
  camTarget = [cx, cy, cz];
  camDist = maxDim * 1.5;
  camTheta = camThetaTarget = Math.PI * 0.25;
  camPhi = camPhiTarget = Math.PI * 0.3;
  camVelTheta = camVelPhi = camVelPanX = camVelPanY = camVelPanZ = 0;
}

function flyTo(targetPos, dist) {
  camAnimating = true;
  camAnimStart = performance.now();
  camAnimDuration = 600;
  camAnimFrom = { target: [...camTarget], dist: camDist };
  camAnimTo = { target: targetPos, dist };
  camVelTheta = camVelPhi = camVelPanX = camVelPanY = camVelPanZ = 0;
}

function updateCamAnimation() {
  if (camAnimating) {
    const t = Math.min(1, (performance.now() - camAnimStart) / camAnimDuration);
    const ease = t < 0.5 ? 2*t*t : 1-(-2*t+2)*(-2*t+2)/2;
    camTarget = camAnimFrom.target.map((v,i) => v + (camAnimTo.target[i]-v)*ease);
    camDist = camAnimFrom.dist + (camAnimTo.dist - camAnimFrom.dist) * ease;
    if (t >= 1) camAnimating = false;
  }
  // Smooth orbit: lerp actual angles toward targets every frame
  camTheta += (camThetaTarget - camTheta) * ORBIT_SMOOTHING;
  camPhi += (camPhiTarget - camPhi) * ORBIT_SMOOTHING;

  // Inertia (only when not dragging)
  if (!isDragging) {
    camThetaTarget += camVelTheta;
    camPhiTarget = Math.max(0.05, Math.min(Math.PI - 0.05, camPhiTarget + camVelPhi));
    camTarget[0] += camVelPanX;
    camTarget[1] += camVelPanY;
    camTarget[2] += camVelPanZ;
    camVelTheta *= FRICTION; camVelPhi *= FRICTION;
    camVelPanX *= FRICTION; camVelPanY *= FRICTION; camVelPanZ *= FRICTION;
    if (Math.abs(camVelTheta) < 1e-5) camVelTheta = 0;
    if (Math.abs(camVelPhi) < 1e-5) camVelPhi = 0;
  }
}

// Mouse controls
let isDragging = false;
let isPanning = false;
let lastMouse = [0, 0];
let mouseDownPos = [0, 0];
let didDrag = false;
const DRAG_THRESHOLD = 3; // px – movement beyond this suppresses click

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  didDrag = false;
  isPanning = e.button === 1 || e.button === 2 || e.shiftKey;
  lastMouse = [e.clientX, e.clientY];
  mouseDownPos = [e.clientX, e.clientY];
  camVelTheta = camVelPhi = camVelPanX = camVelPanY = camVelPanZ = 0;
  e.preventDefault();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mouseup', () => { isDragging = false; isPanning = false; });

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  if (!didDrag) {
    const totalDx = e.clientX - mouseDownPos[0];
    const totalDy = e.clientY - mouseDownPos[1];
    if (totalDx * totalDx + totalDy * totalDy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      didDrag = true;
    }
  }
  const dx = e.clientX - lastMouse[0];
  const dy = e.clientY - lastMouse[1];
  lastMouse = [e.clientX, e.clientY];

  if (isPanning) {
    const panSpeed = camDist * 0.0015;
    // Compute camera right and up vectors for screen-aligned panning
    const ct = Math.cos(camTheta), st = Math.sin(camTheta);
    const rightX = st, rightZ = -ct;
    camVelPanX = -dx * panSpeed * rightX;
    camVelPanZ = -dx * panSpeed * rightZ;
    camVelPanY = dy * panSpeed;
    camTarget[0] += camVelPanX;
    camTarget[1] += camVelPanY;
    camTarget[2] += camVelPanZ;
  } else {
    camVelTheta = dx * 0.004;
    camVelPhi = -dy * 0.004;
    camThetaTarget += camVelTheta;
    camPhiTarget = Math.max(0.05, Math.min(Math.PI - 0.05, camPhiTarget + camVelPhi));
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camDist *= 1 + e.deltaY * 0.001;
  camDist = Math.max(0.01, camDist);
}, { passive: false });

// Touch controls
let lastTouches = [];
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  lastTouches = [...e.touches].map(t => [t.clientX, t.clientY]);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touches = [...e.touches].map(t => [t.clientX, t.clientY]);
  if (touches.length === 1 && lastTouches.length >= 1) {
    const dx = touches[0][0] - lastTouches[0][0];
    const dy = touches[0][1] - lastTouches[0][1];
    camThetaTarget -= dx * 0.005;
    camPhiTarget = Math.max(0.05, Math.min(Math.PI - 0.05, camPhiTarget - dy * 0.005));
  } else if (touches.length === 2 && lastTouches.length >= 2) {
    const d1 = Math.hypot(lastTouches[1][0]-lastTouches[0][0], lastTouches[1][1]-lastTouches[0][1]);
    const d2 = Math.hypot(touches[1][0]-touches[0][0], touches[1][1]-touches[0][1]);
    camDist *= d1 / Math.max(d2, 1);
    camDist = Math.max(0.01, camDist);
  }
  lastTouches = touches;
}, { passive: false });

// ═══════════════════════════════════════════════════════════════════
// 5. PICKING
// ═══════════════════════════════════════════════════════════════════
let pickFbo = null, pickTex = null, pickDepth = null;
let pickW = 0, pickH = 0;

function ensurePickFbo() {
  if (pickFbo && pickW === canvas.width && pickH === canvas.height) return;
  if (pickFbo) { gl.deleteFramebuffer(pickFbo); gl.deleteTexture(pickTex); gl.deleteRenderbuffer(pickDepth); }
  pickW = canvas.width; pickH = canvas.height;
  pickFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
  pickTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, pickTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pickW, pickH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
  pickDepth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, pickW, pickH);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

canvas.addEventListener('click', (e) => {
  if (didDrag) return; // Was a drag, not a click
  if (!pickVao || drawCount === 0) return;
  ensurePickFbo();
  const mvp = getMVP();

  // Render entity IDs into pick FBO using dedicated pick shader + pick VAO
  gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
  gl.viewport(0, 0, pickW, pickH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.disable(gl.BLEND);

  gl.useProgram(pickProg);
  gl.uniformMatrix4fv(pMVP, false, mvp);
  gl.bindVertexArray(pickVao);
  gl.drawElements(gl.TRIANGLES, drawCount, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);

  // Read pixel
  const dpr = Math.min(window.devicePixelRatio, 2);
  const px = Math.floor(e.clientX * dpr);
  const py = pickH - Math.floor(e.clientY * dpr) - 1;
  const pixel = new Uint8Array(4);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);

  const pickedId = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
  if (pickedId > 0 && entityMap.has(pickedId)) {
    showPickInfo(pickedId);
    const info = entityMap.get(pickedId);
    fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'picked', expressId: pickedId, ifcType: info.ifcType }),
    }).catch(() => {});
  } else {
    document.getElementById('pick-info').style.display = 'none';
  }
});

function showPickInfo(eid) {
  const info = entityMap.get(eid);
  if (!info) return;
  const el = document.getElementById('pick-info');
  el.style.display = 'block';
  el.innerHTML =
    '<div class="label">Entity #' + eid + '</div>' +
    '<div class="value">' + info.ifcType + '</div>' +
    '<div class="label">Triangles</div>' +
    '<div class="value">' + Math.floor(info.indexCount / 3).toLocaleString() + '</div>';
}

// ═══════════════════════════════════════════════════════════════════
// 6. COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════
const colorOverrides = new Map();
const STOREY_PALETTE = [
  [0.23,0.55,0.96,1],[0.16,0.73,0.44,1],[0.90,0.30,0.24,1],
  [0.95,0.77,0.06,1],[0.60,0.36,0.71,1],[1.0,0.50,0.05,1],
  [0.10,0.74,0.74,1],[0.83,0.33,0.58,1],[0.38,0.70,0.24,1],
  [0.35,0.47,0.85,1],
];

function applyColorOverrides(colArray) {
  for (const [eid, color] of colorOverrides) {
    const info = entityMap.get(eid);
    if (!info) continue;
    for (const seg of info.segments) {
      for (let i = 0; i < seg.vertexCount; i++) {
        const vi = (seg.vertexStart + i) * 4;
        colArray[vi] = color[0]; colArray[vi+1] = color[1];
        colArray[vi+2] = color[2]; colArray[vi+3] = color[3];
      }
    }
  }
}

// Track which entity IDs have changed since last refreshColors
let colorDirtyAll = true; // true = full rebuild needed (initial load, reset)
const colorDirtyEntities = new Set();

function markColorDirty(eid) { colorDirtyEntities.add(eid); }
function markAllColorsDirty() { colorDirtyAll = true; }

function refreshColors() {
  if (!vao) return;

  if (colorDirtyAll) {
    // Full rebuild — needed after initial load or reset
    const col = mergeFloat32(colors, totalVertices * 4);
    applyColorOverrides(col);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    colorDirtyAll = false;
    colorDirtyEntities.clear();
    return;
  }

  // Partial update — only update changed entities via bufferSubData
  if (colorDirtyEntities.size === 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
  for (const eid of colorDirtyEntities) {
    const info = entityMap.get(eid);
    if (!info) continue;
    const override = colorOverrides.get(eid);
    for (const seg of info.segments) {
      const buf = new Float32Array(seg.vertexCount * 4);
      if (override) {
        for (let i = 0; i < seg.vertexCount; i++) {
          buf[i*4] = override[0]; buf[i*4+1] = override[1];
          buf[i*4+2] = override[2]; buf[i*4+3] = override[3];
        }
      } else {
        // Restore default color from the original colors array
        const dc = info.defaultColor;
        for (let i = 0; i < seg.vertexCount; i++) {
          buf[i*4] = dc[0]; buf[i*4+1] = dc[1]; buf[i*4+2] = dc[2]; buf[i*4+3] = dc[3];
        }
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, seg.vertexStart * 4 * 4, buf);
    }
  }
  colorDirtyEntities.clear();
}

const NAMED_COLORS = {
  red:[1,0,0,1],green:[0,0.7,0,1],blue:[0,0.3,1,1],yellow:[1,0.9,0,1],
  orange:[1,0.5,0,1],purple:[0.6,0.2,0.8,1],cyan:[0,0.8,0.8,1],
  white:[1,1,1,1],pink:[1,0.4,0.7,1],gray:[0.5,0.5,0.5,1],
};

function resolveColor(c) {
  if (typeof c === 'string') return NAMED_COLORS[c.toLowerCase()] || [1,0,0,1];
  if (Array.isArray(c)) return c;
  return [1,0,0,1];
}

function matchesType(info, type) {
  // Require exact IFC EXPRESS name match (e.g. "IfcWall", not "Wall")
  return info.ifcType === type;
}

function getEntityBoundsForFilter(filterFn) {
  const tMin = [Infinity,Infinity,Infinity], tMax = [-Infinity,-Infinity,-Infinity];
  let found = false;
  for (const [eid, info] of entityMap) {
    if (!filterFn(eid, info)) continue;
    found = true;
    for (let k = 0; k < 3; k++) {
      tMin[k] = Math.min(tMin[k], info.boundsMin[k]);
      tMax[k] = Math.max(tMax[k], info.boundsMax[k]);
    }
  }
  if (!found) return null;
  return { min: tMin, max: tMax };
}

function handleCommand(cmd) {
  showCmdLog(cmd.action);

  switch (cmd.action) {
    // ── Type-based commands ──
    case 'colorize': {
      const color = resolveColor(cmd.color);
      for (const [eid, info] of entityMap) {
        if (matchesType(info, cmd.type)) { colorOverrides.set(eid, color); markColorDirty(eid); }
      }
      refreshColors();
      break;
    }
    case 'isolate': {
      const types = cmd.types || [cmd.type];
      for (const [eid, info] of entityMap) {
        if (!types.some(t => matchesType(info, t))) {
          colorOverrides.set(eid, [0.3, 0.3, 0.35, 0.06]);
        } else {
          colorOverrides.delete(eid);
        }
        markColorDirty(eid);
      }
      refreshColors();
      break;
    }
    case 'xray': {
      const opacity = cmd.opacity ?? 0.15;
      for (const [eid, info] of entityMap) {
        if (matchesType(info, cmd.type)) {
          const dc = info.defaultColor;
          colorOverrides.set(eid, [dc[0], dc[1], dc[2], opacity]);
          markColorDirty(eid);
        }
      }
      refreshColors();
      break;
    }
    case 'flyto': {
      const bounds = getEntityBoundsForFilter((eid, info) =>
        cmd.ids ? cmd.ids.includes(eid) : matchesType(info, cmd.type)
      );
      if (bounds) {
        const center = bounds.min.map((v,i) => (v + bounds.max[i]) / 2);
        const dim = Math.max(...bounds.max.map((v,i) => v - bounds.min[i]), 0.1);
        flyTo(center, dim * 1.5);
      }
      break;
    }

    // ── Entity ID-based commands (from streaming adapter) ──
    case 'colorizeEntities': {
      const color = resolveColor(cmd.color);
      for (const id of cmd.ids) { colorOverrides.set(id, color); markColorDirty(id); }
      refreshColors();
      break;
    }
    case 'isolateEntities': {
      const idSet = new Set(cmd.ids);
      for (const [eid] of entityMap) {
        if (!idSet.has(eid)) {
          colorOverrides.set(eid, [0.3, 0.3, 0.35, 0.06]);
        } else {
          colorOverrides.delete(eid);
        }
        markColorDirty(eid);
      }
      refreshColors();
      break;
    }
    case 'hideEntities': {
      for (const id of cmd.ids) { colorOverrides.set(id, [0, 0, 0, 0]); markColorDirty(id); }
      refreshColors();
      break;
    }
    case 'showEntities': {
      for (const id of cmd.ids) { colorOverrides.delete(id); markColorDirty(id); }
      refreshColors();
      break;
    }
    case 'resetColorEntities': {
      for (const id of cmd.ids) { colorOverrides.delete(id); markColorDirty(id); }
      refreshColors();
      break;
    }
    case 'highlight': {
      for (const id of (cmd.ids || [])) { colorOverrides.set(id, [1, 0.9, 0, 1]); markColorDirty(id); }
      refreshColors();
      break;
    }

    // ── Section plane ──
    case 'section': {
      sectionEnabled = true;
      // Accept both flat (cmd.axis/cmd.position) and nested (cmd.section.axis/position) formats
      const sec = cmd.section || cmd;
      const axis = (sec.axis || 'y').toLowerCase();
      const axisIdx = axis === 'x' ? 0 : axis === 'z' ? 2 : 1;
      // Support "center", percentage strings like "50%", or absolute numbers
      let pos;
      const rawPos = sec.position;
      if (rawPos === 'center' || rawPos === undefined) {
        pos = (boundsMin[axisIdx] + boundsMax[axisIdx]) / 2;
      } else if (typeof rawPos === 'string' && rawPos.endsWith('%')) {
        const pct = parseFloat(rawPos) / 100;
        pos = boundsMin[axisIdx] + (boundsMax[axisIdx] - boundsMin[axisIdx]) * pct;
      } else {
        pos = Number(rawPos) || 0;
      }
      sectionPlane = [
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
        pos,
      ];
      break;
    }
    case 'clearSection':
      sectionEnabled = false;
      break;

    // ── Color by storey (Y-based binning, adaptive to model scale) ──
    case 'colorByStorey': {
      // Compute adaptive bin size from model Y extent instead of hardcoded 3m
      const yExtent = boundsMax[1] - boundsMin[1];
      // Aim for ~3-10 storeys; clamp bin size to reasonable range
      const targetStoreys = Math.max(3, Math.min(10, Math.round(yExtent / 3)));
      const binSize = Math.max(yExtent / targetStoreys, 0.01);
      const yGroups = new Map();
      for (const [eid, info] of entityMap) {
        const avgY = (info.boundsMin[1] + info.boundsMax[1]) / 2;
        const bin = Math.floor((avgY - boundsMin[1]) / binSize);
        if (!yGroups.has(bin)) yGroups.set(bin, []);
        yGroups.get(bin).push(eid);
      }
      const sortedBins = [...yGroups.keys()].sort((a,b) => a-b);
      for (let i = 0; i < sortedBins.length; i++) {
        const color = STOREY_PALETTE[i % STOREY_PALETTE.length];
        for (const eid of yGroups.get(sortedBins[i])) colorOverrides.set(eid, color);
      }
      markAllColorsDirty();
      refreshColors();
      break;
    }

    // ── Add geometry (live creation streaming) ──
    case 'addGeometry': {
      if (!wasmApi || !cmd.ifcContent) break;
      // Each addGeometry call gets a unique ID namespace to prevent collisions
      nextIdNamespace++;
      const idOffset = nextIdNamespace * ID_NAMESPACE_SIZE;
      parseMeshesViaPrePass(wasmApi, cmd.ifcContent, {
        batchSize: 50,
        onBatch: (meshes) => {
          const batch = meshes.map(m => ({
            expressId: m.expressId + idOffset,
            ifcType: m.ifcType || 'Created',
            positions: m.positions,
            normals: m.normals,
            indices: m.indices,
            color: [m.color[0], m.color[1], m.color[2], m.color[3] ?? 1],
          }));
          addMeshBatch(batch);
          // Track and auto-highlight new geometry in green
          for (const m of batch) {
            createdEntityIds.add(m.expressId);
            colorOverrides.set(m.expressId, [0.2, 0.9, 0.4, 1]);
            markColorDirty(m.expressId);
          }
          refreshColors();
          document.getElementById('model-stats').textContent =
            totalTriangles.toLocaleString() + ' triangles, ' +
            entityMap.size.toLocaleString() + ' entities';
        },
      }).catch(err => console.error('addGeometry error:', err));
      break;
    }

    // ── Programmatic camera views (for CLI/LLM) ──
    case 'setView': {
      // Named views: front, back, left, right, top, bottom, iso
      // theta = azimuth around Y, phi = angle from Y+ (0=top, PI/2=horizon)
      const VIEWS = {
        front:  { theta: 0,               phi: Math.PI * 0.4 },
        back:   { theta: Math.PI,          phi: Math.PI * 0.4 },
        left:   { theta: Math.PI * 1.5,    phi: Math.PI * 0.4 },
        right:  { theta: Math.PI * 0.5,    phi: Math.PI * 0.4 },
        top:    { theta: 0,               phi: 0.05 },
        bottom: { theta: 0,               phi: Math.PI - 0.05 },
        iso:    { theta: Math.PI * 0.25,   phi: Math.PI * 0.3 },
      };
      const view = cmd.view?.toLowerCase();
      const preset = VIEWS[view];
      if (preset) {
        camAnimating = true;
        camAnimStart = performance.now();
        camAnimDuration = 500;
        camAnimFrom = { target: [...camTarget], dist: camDist };
        camAnimTo = { target: [...camTarget], dist: camDist };
        // Animate theta/phi by setting target directly after animation
        camTheta = camThetaTarget = preset.theta;
        camPhi = camPhiTarget = preset.phi;
        camVelTheta = camVelPhi = 0;
      }
      break;
    }

    // ── Remove created geometry ──
    case 'removeCreated': {
      // Hide all entities added via addGeometry by making them fully transparent
      for (const eid of createdEntityIds) {
        colorOverrides.set(eid, [0, 0, 0, 0]);
        markColorDirty(eid);
      }
      createdEntityIds.clear();
      refreshColors();
      document.getElementById('model-stats').textContent =
        totalTriangles.toLocaleString() + ' triangles, ' +
        entityMap.size.toLocaleString() + ' entities';
      break;
    }

    // ── General ──
    case 'showall':
      colorOverrides.clear();
      markAllColorsDirty();
      refreshColors();
      break;
    case 'reset':
      colorOverrides.clear();
      sectionEnabled = false;
      markAllColorsDirty();
      refreshColors();
      fitCamera();
      break;
    case 'connected':
      break;
    default:
      console.log('Unknown command:', cmd);
  }
}

function showCmdLog(action) {
  if (action === 'connected') return;
  const el = document.getElementById('cmd-log');
  el.style.display = 'block';
  el.textContent = '> ' + action;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ═══════════════════════════════════════════════════════════════════
// 7. RENDER LOOP
// ═══════════════════════════════════════════════════════════════════
const BG = [0.102, 0.102, 0.18, 1];

function getMVP() {
  const aspect = canvas.width / canvas.height;
  const proj = mat4.perspective(Math.PI / 4, aspect, camDist * 0.001, camDist * 100);
  const eye = getCamPos();
  const view = mat4.lookAt(eye, camTarget, [0, 1, 0]);
  return mat4.multiply(proj, view);
}

function render() {
  updateCamAnimation();
  resize();

  gl.clearColor(...BG);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  const mvp = getMVP();

  // ── Draw ground grid ──
  if (boundsMax[0] > boundsMin[0]) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(gridProg);
    gl.uniformMatrix4fv(gMVP, false, mvp);
    gl.uniform1f(gGridY, boundsMin[1] - 0.01);
    const maxDim = Math.max(boundsMax[0]-boundsMin[0], boundsMax[2]-boundsMin[2], 1);
    gl.uniform1f(gGridScale, Math.pow(10, Math.floor(Math.log10(maxDim / 5))));
    gl.uniform1f(gGridExtent, maxDim * 3);
    gl.bindVertexArray(gridVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  // ── Draw model ──
  if (vao && drawCount > 0) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const view = mat4.lookAt(getCamPos(), camTarget, [0, 1, 0]);
    const normMat = mat4.transpose(mat4.invert(view));

    gl.useProgram(prog);
    gl.uniformMatrix4fv(uMVP, false, mvp);
    gl.uniformMatrix4fv(uNormMat, false, normMat);
    gl.uniform1i(uSectionEnabled, sectionEnabled ? 1 : 0);
    gl.uniform4fv(uSectionPlane, sectionPlane);
    gl.uniform1f(uEdgeStrength, 8.0);

    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, drawCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  requestAnimationFrame(render);
}

// ═══════════════════════════════════════════════════════════════════
// 8. SSE CLIENT
// ═══════════════════════════════════════════════════════════════════
let sseRetryDelay = 1000;
function connectSSE() {
  const es = new EventSource('/events');
  es.onopen = () => { sseRetryDelay = 1000; }; // Reset backoff on success
  es.onmessage = (e) => {
    try { handleCommand(JSON.parse(e.data)); }
    catch (err) { console.error('SSE parse error:', err); }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, sseRetryDelay);
    sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);
  };
}

// ═══════════════════════════════════════════════════════════════════
// 9. MESH STREAMING (pre-pass + job batches — the canonical geometry path)
// ═══════════════════════════════════════════════════════════════════
// Drop-in replacement for the removed legacy wasmApi.parseMeshesAsync.
// Same callback contract: onBatch(meshes, { percent }) and onComplete().
// meshes are MeshDataJs objects (.expressId/.ifcType/.positions/.normals/
// .indices/.color), identical to what the old async API yielded.
async function parseMeshesViaPrePass(api, content, opts) {
  opts = opts || {};
  const batchSize = opts.batchSize || 50;
  const onBatch = opts.onBatch;
  const onComplete = opts.onComplete;

  const bytes = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(bytes);
  const total = (pre && pre.totalJobs) || 0;

  if (pre && pre.jobs && total > 0) {
    const rtcX = pre.rtcOffset ? (pre.rtcOffset[0] || 0) : 0;
    const rtcY = pre.rtcOffset ? (pre.rtcOffset[1] || 0) : 0;
    const rtcZ = pre.rtcOffset ? (pre.rtcOffset[2] || 0) : 0;
    // Cap at ~30 batches like the main viewer's byte-streaming path.
    const step = Math.max(batchSize, Math.ceil(total / 30));
    for (let start = 0; start < total; start += step) {
      const end = Math.min(start + step, total);
      const jobSlice = pre.jobs.slice(start * 3, end * 3);
      const collection = api.processGeometryBatch(
        bytes, jobSlice, pre.unitScale, rtcX, rtcY, rtcZ, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      );
      const meshes = [];
      for (let i = 0; i < collection.length; i++) {
        const m = collection.get(i);
        if (m) meshes.push(m);
      }
      if (meshes.length && onBatch) {
        onBatch(meshes, { percent: Math.min(100, Math.round((end / total) * 100)) });
      }
      // Yield to the event loop so the canvas paints progressively.
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (api.clearPrePassCache) api.clearPrePassCache();
  if (onComplete) onComplete();
}

// ═══════════════════════════════════════════════════════════════════
// 9. LOAD MODEL
// ═══════════════════════════════════════════════════════════════════
async function loadModel() {
  const loadingText = document.getElementById('loading-text');
  const progressBar = document.getElementById('progress-bar');
  const statsEl = document.getElementById('model-stats');

  try {
    loadingText.textContent = 'Initializing geometry engine...';
    const wasm = await import('/wasm/ifc-lite.js');
    await wasm.default();
    const api = new wasm.IfcAPI();
    wasmApi = api; // Store globally for addGeometry

    loadingText.textContent = 'Downloading model...';
    const resp = await fetch('/model.ifc');

    if (resp.status === 204) {
      // Empty mode — no model to load, just wait for commands
      statsEl.textContent = 'Empty scene — waiting for geometry';
    } else {
      const buffer = await resp.arrayBuffer();
      const content = new TextDecoder().decode(buffer);
      loadingText.textContent = 'Parsing geometry...';

      let cameraFitted = false;
      await parseMeshesViaPrePass(api, content, {
        batchSize: 50,
        onBatch: (meshes, progress) => {
          const batch = meshes.map(m => ({
            expressId: m.expressId,
            ifcType: m.ifcType || 'Unknown',
            positions: m.positions,
            normals: m.normals,
            indices: m.indices,
            color: [m.color[0], m.color[1], m.color[2], m.color[3] ?? 1],
          }));
          addMeshBatch(batch);
          progressBar.style.width = progress.percent + '%';

          if (!cameraFitted && totalVertices > 0) {
            fitCamera();
            cameraFitted = true;
          }

          statsEl.textContent = totalTriangles.toLocaleString() + ' triangles, ' +
            entityMap.size.toLocaleString() + ' entities (' + Math.round(progress.percent) + '%)';
        },
        onComplete: () => {
          progressBar.style.width = '100%';
          setTimeout(() => { document.getElementById('progress-wrap').style.opacity = '0'; }, 1000);
        },
      });

      if (totalVertices > 0) fitCamera();

      statsEl.textContent = totalTriangles.toLocaleString() + ' triangles, ' +
        entityMap.size.toLocaleString() + ' entities';
      statsEl.title = [...typeCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8)
        .map(([t,c]) => t + ': ' + c).join(', ');
    }

    document.getElementById('loading').style.display = 'none';

  } catch (err) {
    loadingText.textContent = 'Error: ' + err.message;
    console.error('Load error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 10. INIT
// ═══════════════════════════════════════════════════════════════════
requestAnimationFrame(render);
connectSSE();
loadModel();

window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'Home') fitCamera();
  if (e.key === 'Escape') {
    colorOverrides.clear();
    sectionEnabled = false;
    markAllColorsDirty();
    refreshColors();
    document.getElementById('pick-info').style.display = 'none';
  }
});
</script>
</body>
</html>`;
}
