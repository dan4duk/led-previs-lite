// Small vector / matrix helpers and the camera solver (DLT) used to match a 3D model to a photo.
// Cameras are 3x4 projection matrices stored row-major as 12 numbers: [u*w, v*w, w] = P * [X, Y, Z, 1].
// w is the distance in front of the camera (the third row is normalised to a unit direction), so w > 0 means "in front".

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Project a world point. Returns [u, v, w] (pixels and depth). */
export function project(P, X) {
  const x = X[0], y = X[1], z = X[2];
  const w = P[8] * x + P[9] * y + P[10] * z + P[11];
  return [(P[0] * x + P[1] * y + P[2] * z + P[3]) / w, (P[4] * x + P[5] * y + P[6] * z + P[7]) / w, w];
}

/** A pinhole camera looking from eye at target. fovY in degrees. Image size W x H pixels, y down. */
export function lookAtP(eye, target, up, fovY, W, H) {
  const f = norm(sub(target, eye)), r = norm(cross(f, up)), u = cross(r, f);
  const F = (H / 2) / Math.tan((fovY * Math.PI / 180) / 2), cx = W / 2, cy = H / 2;
  const r0 = [F * r[0] + cx * f[0], F * r[1] + cx * f[1], F * r[2] + cx * f[2]];
  const r1 = [-F * u[0] + cy * f[0], -F * u[1] + cy * f[1], -F * u[2] + cy * f[2]];
  return [...r0, -dot(r0, eye), ...r1, -dot(r1, eye), ...f, -dot(f, eye)];
}

/** Scale a camera defined in one pixel space into another (s, then offset ox, oy). */
export function remapP(P, s, ox, oy) {
  const M = [[s, 0, ox], [0, s, oy], [0, 0, 1]], out = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = M[i][0] * P[j] + M[i][1] * P[4 + j] + M[i][2] * P[8 + j];
  return out;
}

/** Camera centre in world space (null-space of P). */
export function cameraCentre(P) {
  const M = [[P[0], P[1], P[2]], [P[4], P[5], P[6]], [P[8], P[9], P[10]]], p4 = [P[3], P[7], P[11]];
  const d = det3(M); if (Math.abs(d) < 1e-12) return null;
  const inv = inv3(M), c = [0, 0, 0];
  for (let i = 0; i < 3; i++) c[i] = -(inv[i][0] * p4[0] + inv[i][1] * p4[1] + inv[i][2] * p4[2]);
  return c;
}
function det3(m) { return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]); }
function inv3(m) {
  const d = det3(m), c = (a, b, e, f) => a * f - b * e;
  return [[c(m[1][1], m[1][2], m[2][1], m[2][2]) / d, -c(m[0][1], m[0][2], m[2][1], m[2][2]) / d, c(m[0][1], m[0][2], m[1][1], m[1][2]) / d],
          [-c(m[1][0], m[1][2], m[2][0], m[2][2]) / d, c(m[0][0], m[0][2], m[2][0], m[2][2]) / d, -c(m[0][0], m[0][2], m[1][0], m[1][2]) / d],
          [c(m[1][0], m[1][1], m[2][0], m[2][1]) / d, -c(m[0][0], m[0][1], m[2][0], m[2][1]) / d, c(m[0][0], m[0][1], m[1][0], m[1][1]) / d]];
}

/** Eigen-decomposition of a symmetric n x n matrix (array of arrays) by cyclic Jacobi rotations.
 *  Returns { values (ascending), vectors } where vectors[k] is the unit eigenvector for values[k]. */
export function jacobiEigen(S, n) {
  const A = S.map((r) => r.slice()), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[a][a] - A[b][b]);
  return { values: idx.map((i) => A[i][i]), vectors: idx.map((i) => V.map((row) => row[i])) };
}

function normalise2(pts) {
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const d = pts.reduce((a, p) => a + Math.hypot(p[0] - mx, p[1] - my), 0) / n || 1, s = Math.SQRT2 / d;
  return { s, mx, my, pts: pts.map((p) => [(p[0] - mx) * s, (p[1] - my) * s]) };
}
function normalise3(pts) {
  const n = pts.length, c = [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / n);
  const d = pts.reduce((a, p) => a + len(sub(p, c)), 0) / n || 1, s = Math.sqrt(3) / d;
  return { s, c, pts: pts.map((p) => mul(sub(p, c), s)) };
}
function smallestEigenvector(rows, cols) {
  const S = Array.from({ length: cols }, () => new Array(cols).fill(0));
  for (const r of rows) for (let i = 0; i < cols; i++) for (let j = i; j < cols; j++) S[i][j] += r[i] * r[j];
  for (let i = 0; i < cols; i++) for (let j = 0; j < i; j++) S[i][j] = S[j][i];
  return jacobiEigen(S, cols).vectors[0];
}

function finish(P, world, image) {
  // normalise the scale (third row direction = unit) and flip the sign so the points are in front of the camera
  let k = Math.hypot(P[8], P[9], P[10]) || 1; P = P.map((v) => v / k);
  const cen = [0, 1, 2].map((a) => world.reduce((s, p) => s + p[a], 0) / world.length);
  if (project(P, cen)[2] < 0) P = P.map((v) => -v);
  let se = 0, maxe = 0;
  world.forEach((X, i) => { const q = project(P, X), e = Math.hypot(q[0] - image[i][0], q[1] - image[i][1]); se += e * e; maxe = Math.max(maxe, e); });
  return { P, rms: Math.sqrt(se / world.length), max: maxe };
}

/** Is the set of 3D points (nearly) flat? Returns the plane frame if so. */
export function planeFit(world) {
  const n = world.length, c = [0, 1, 2].map((k) => world.reduce((a, p) => a + p[k], 0) / n);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  world.forEach((p) => { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; });
  const e = jacobiEigen(C, 3);
  return { flat: e.values[0] < 1e-5 * e.values[2], centre: c, normal: e.vectors[0], axes: [e.vectors[2], e.vectors[1]] };
}

/** Solve a camera from world <-> image point pairs.
 *  Needs 6+ pairs that are not all in one plane (DLT), or 4+ pairs in one plane (homography).
 *  Returns { P, rms, max, mode } or { error }. */
export function solveCamera(world, image) {
  const n = world.length;
  if (n < 4) return { error: "Need at least 4 point pairs (6 if the points are not on one flat surface)." };
  const pl = planeFit(world);
  if (pl.flat) {
    const plane = world.map((p) => { const d = sub(p, pl.centre); return [dot(d, pl.axes[0]), dot(d, pl.axes[1])]; });
    const a = normalise2(plane), b = normalise2(image), rows = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = a.pts[i], [u, v] = b.pts[i];
      rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]);
    }
    const h = smallestEigenvector(rows, 9);
    // Hn maps normalised plane coords to normalised image coords; undo the normalisations
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
    const Tp = [[a.s, 0, -a.s * a.mx], [0, a.s, -a.s * a.my], [0, 0, 1]], Ti = [[1 / b.s, 0, b.mx], [0, 1 / b.s, b.my], [0, 0, 1]];
    const mm = (X, Y) => X.map((r) => [0, 1, 2].map((j) => r[0] * Y[0][j] + r[1] * Y[1][j] + r[2] * Y[2][j]));
    const H = mm(Ti, mm(Hn, Tp));
    // plane coords (a, b) of a world point X: a = e1.(X-c), b = e2.(X-c)
    const e1 = pl.axes[0], e2 = pl.axes[1], c = pl.centre;
    const Aff = [[e1[0], e1[1], e1[2], -dot(e1, c)], [e2[0], e2[1], e2[2], -dot(e2, c)], [0, 0, 0, 1]];
    const Pm = [0, 1, 2].map((i) => [0, 1, 2, 3].map((j) => H[i][0] * Aff[0][j] + H[i][1] * Aff[1][j] + H[i][2] * Aff[2][j]));
    const fin = finish(Pm.flat(), world, image);
    return { ...fin, mode: "flat surface (homography)" };
  }
  if (n < 6) return { error: "Points that are not on one flat surface need at least 6 pairs." };
  const a = normalise3(world), b = normalise2(image), rows = [];
  for (let i = 0; i < n; i++) {
    const [X, Y, Z] = a.pts[i], [u, v] = b.pts[i];
    rows.push([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z, -u], [0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z, -v]);
  }
  const p = smallestEigenvector(rows, 12);
  const T3 = [[a.s, 0, 0, -a.s * a.c[0]], [0, a.s, 0, -a.s * a.c[1]], [0, 0, a.s, -a.s * a.c[2]], [0, 0, 0, 1]];
  const Ti = [[1 / b.s, 0, b.mx], [0, 1 / b.s, b.my], [0, 0, 1]];
  const Pn = [p.slice(0, 4), p.slice(4, 8), p.slice(8, 12)];
  const P = [];
  for (let i = 0; i < 3; i++) {
    const t = [0, 1, 2, 3].map((j) => Ti[i][0] * Pn[0][j] + Ti[i][1] * Pn[1][j] + Ti[i][2] * Pn[2][j]);
    for (let j = 0; j < 4; j++) P.push(t[0] * T3[0][j] + t[1] * T3[1][j] + t[2] * T3[2][j] + t[3] * T3[3][j]);
  }
  return { ...finish(P, world, image), mode: "3D camera (DLT)" };
}
