// Wavefront OBJ import: parse, pick out the sharp edges (for the wireframe), and place the model in the project's frame.
// Project frame: metres, x east, y north, z up. OBJ files differ in units and up axis, so those are options (see transformModel).

export const UNITS = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

/** Parse OBJ text. Returns { pos: Float64Array (x,y,z per vertex), tris: Uint32Array (3 per triangle), lines: Uint32Array (2 per line element) }.
 *  Polygons are fan-triangulated; vt/vn/materials/groups are ignored. */
export function parseOBJ(text) {
  const pos = [], tris = [], lines = [];
  const idx = (tok, n) => { const i = parseInt(tok, 10); return i < 0 ? n + i : i - 1; };   // 1-based, negative = relative to the end
  let start = 0; const len = text.length;
  while (start < len) {
    let end = text.indexOf("\n", start); if (end < 0) end = len;
    const c0 = text.charCodeAt(start), c1 = text.charCodeAt(start + 1);
    if (c0 === 118 && (c1 === 32 || c1 === 9)) {                       // v x y z
      const p = text.substring(start + 2, end).trim().split(/\s+/); pos.push(+p[0], +p[1], +p[2]);
    } else if (c0 === 102 && (c1 === 32 || c1 === 9)) {                // f a/b/c d/e/f ...
      const p = text.substring(start + 2, end).trim().split(/\s+/), n = pos.length / 3, ix = p.map((t) => idx(t.split("/")[0], n));
      for (let k = 1; k + 1 < ix.length; k++) tris.push(ix[0], ix[k], ix[k + 1]);
    } else if (c0 === 108 && (c1 === 32 || c1 === 9)) {                // l a b c
      const p = text.substring(start + 2, end).trim().split(/\s+/), n = pos.length / 3, ix = p.map((t) => idx(t.split("/")[0], n));
      for (let k = 0; k + 1 < ix.length; k++) lines.push(ix[k], ix[k + 1]);
    }
    start = end + 1;
  }
  const nv = pos.length / 3, bad = (i) => !(i >= 0 && i < nv);
  const okT = []; for (let i = 0; i < tris.length; i += 3) if (!bad(tris[i]) && !bad(tris[i + 1]) && !bad(tris[i + 2])) okT.push(tris[i], tris[i + 1], tris[i + 2]);
  const okL = []; for (let i = 0; i < lines.length; i += 2) if (!bad(lines[i]) && !bad(lines[i + 1])) okL.push(lines[i], lines[i + 1]);
  return { pos: Float64Array.from(pos), tris: Uint32Array.from(okT), lines: Uint32Array.from(okL) };
}

/** The sharp edges of the mesh: boundary edges plus edges where the two faces differ by more than `angle` degrees.
 *  Vertices at the same place (split by normals/uvs) are welded first. Returns Uint32Array of vertex-index pairs (original indices). */
export function featureEdges(m, angle = 28) {
  const { pos, tris } = m, nv = pos.length / 3, cosT = Math.cos((angle * Math.PI) / 180);
  const q = new Map(), canon = new Int32Array(nv); let nc = 0; const first = [];
  for (let i = 0; i < nv; i++) {
    const k = Math.round(pos[3 * i] * 1000) + "," + Math.round(pos[3 * i + 1] * 1000) + "," + Math.round(pos[3 * i + 2] * 1000);
    let c = q.get(k); if (c === undefined) { c = nc++; q.set(k, c); first.push(i); } canon[i] = c;
  }
  const edges = new Map();
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12) continue; nx /= l; ny /= l; nz /= l;
    const cc = [canon[a], canon[b], canon[c]];
    for (let e = 0; e < 3; e++) {
      const u = cc[e], v = cc[(e + 1) % 3]; if (u === v) continue;
      const key = u < v ? u * nc + v : v * nc + u, rec = edges.get(key);
      if (!rec) edges.set(key, { u: Math.min(u, v), v: Math.max(u, v), n: [nx, ny, nz], c: 1, f: false });
      else { rec.c++; if (rec.c > 2 || Math.abs(rec.n[0] * nx + rec.n[1] * ny + rec.n[2] * nz) < cosT) rec.f = true; }
    }
  }
  const out = [];
  for (const r of edges.values()) if (r.c === 1 || r.f) out.push(first[r.u], first[r.v]);
  for (let i = 0; i < m.lines.length; i++) out.push(m.lines[i]);            // explicit OBJ line elements
  return Uint32Array.from(out);
}

export function extents(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/** Guess the unit from the overall size. A rig or venue is roughly 3 to 40 m across, so: under 100 is metres, 100 to 4000 is centimetres,
 *  more than that is millimetres. (A 40 m+ venue in cm or a 4 m model in mm is ambiguous: use the Units buttons.) */
export function guessUnits(pos) { const e = extents(pos), m = Math.max(...e.size); return m >= 4000 ? "mm" : m >= 100 ? "cm" : "m"; }
/** Guess the up axis: the shorter of Y and Z is usually the height of a room or rig. */
export function guessUp(pos) { const e = extents(pos); return e.size[2] <= e.size[1] ? "z" : "y"; }

/** Place the parsed model in the project frame.
 *  opts: { units: m|cm|mm|ft|in, up: "z"|"y", rot: degrees about z (0/90/180/270), place: "asis"|"floor"|"centre" }.
 *  Returns { segments: Float32Array (x1,y1,z1,x2,y2,z2 per edge), mesh: Float32Array (pos+normal per vertex, 3 vertices per triangle), size, lo, hi }. */
export function transformModel(m, edgeIdx, opts) {
  const s = UNITS[opts.units] || 1, th = ((opts.rot || 0) * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th), n = m.pos.length / 3, P = new Float64Array(m.pos.length);
  for (let i = 0; i < n; i++) {
    let x = m.pos[3 * i] * s, y = m.pos[3 * i + 1] * s, z = m.pos[3 * i + 2] * s;
    if (opts.up === "y") { const t = y; y = -z; z = t; }              // Y-up (Blender/most exporters) -> Z-up
    P[3 * i] = x * cs - y * sn; P[3 * i + 1] = x * sn + y * cs; P[3 * i + 2] = z;
  }
  const e = extents(P); let ox = 0, oy = 0, oz = 0;
  if (opts.place === "floor" || opts.place === "centre") oz = -e.lo[2];
  if (opts.place === "centre") { ox = -(e.lo[0] + e.hi[0]) / 2; oy = -(e.lo[1] + e.hi[1]) / 2; }
  for (let i = 0; i < n; i++) { P[3 * i] += ox; P[3 * i + 1] += oy; P[3 * i + 2] += oz; }
  const seg = new Float32Array(edgeIdx.length * 3);
  for (let i = 0; i < edgeIdx.length; i++) { const v = edgeIdx[i]; seg[3 * i] = P[3 * v]; seg[3 * i + 1] = P[3 * v + 1]; seg[3 * i + 2] = P[3 * v + 2]; }
  const T = m.tris.length / 3, mesh = new Float32Array(T * 18);
  for (let t = 0; t < T; t++) {
    const a = m.tris[3 * t], b = m.tris[3 * t + 1], c = m.tris[3 * t + 2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2], vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    [a, b, c].forEach((v, k) => { const o = t * 18 + k * 6; mesh[o] = P[3 * v]; mesh[o + 1] = P[3 * v + 1]; mesh[o + 2] = P[3 * v + 2]; mesh[o + 3] = nx; mesh[o + 4] = ny; mesh[o + 5] = nz; });
  }
  const f = extents(P);
  return { segments: seg, mesh, size: f.size, lo: f.lo, hi: f.hi };
}
