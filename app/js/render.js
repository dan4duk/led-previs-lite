// WebGL renderer: photo backdrop, LED panels textured from the screen content, wireframe model.
// A camera is a 3x4 projection matrix P (12 numbers, row-major) in the pixel space of the canvas being drawn into
// (see math.js). Perspective-correct texturing comes for free because the vertex shader outputs clip w = camera depth.
import { norm, cross, dot, sub, mul, add, cameraCentre, project } from "./math.js";

const VS_PROJ = `
uniform vec4 uP0, uP1, uP2; uniform vec2 uSize; uniform float uFar;
vec4 projectToClip(vec3 p) {
  vec4 X = vec4(p, 1.0);
  float u = dot(uP0, X), v = dot(uP1, X), w = dot(uP2, X);
  float zn = clamp(w / uFar, 0.0, 1.0) * 2.0 - 1.0;
  return vec4(2.0 * u / uSize.x - w, w - 2.0 * v / uSize.y, zn * w, w);
}`;
const PANEL_VS = VS_PROJ + `
attribute vec3 aPos; attribute vec2 aUV; attribute vec3 aN; uniform vec3 uEye; uniform float uCull;
varying vec2 vUV; varying float vFront;
void main() { gl_Position = projectToClip(aPos); vUV = aUV; vFront = (uCull > 0.5) ? step(0.0, dot(aN, uEye - aPos)) : 1.0; }`;
const PANEL_FS = `precision mediump float;
uniform sampler2D uTex; uniform float uGain; uniform vec3 uBase; uniform float uUseAlpha; varying vec2 vUV; varying float vFront;
void main() { if (vFront < 0.5) discard; vec4 t = texture2D(uTex, vUV); vec3 c = t.rgb * (uUseAlpha > 0.5 ? t.a : 1.0); gl_FragColor = vec4(uBase + c * uGain, 1.0); }`;
const LINE_VS = VS_PROJ + `attribute vec3 aPos; void main() { gl_Position = projectToClip(aPos); }`;
const LINE_FS = `precision mediump float; uniform vec4 uColor; void main() { gl_FragColor = uColor; }`;
const MESH_VS = VS_PROJ + `attribute vec3 aPos; attribute vec3 aN; varying float vL;
void main() { gl_Position = projectToClip(aPos); vL = abs(dot(normalize(aN), normalize(vec3(0.35, -0.5, 0.8)))); }`;
const MESH_FS = `precision mediump float; varying float vL; uniform vec3 uCol; void main() { gl_FragColor = vec4(uCol * (0.4 + 0.6 * vL), 1.0); }`;
const PHOTO_VS = `attribute vec2 aXY; uniform vec4 uRect; varying vec2 vUV;
void main() { vUV = vec2(aXY.x, 1.0 - aXY.y); gl_Position = vec4(mix(uRect.xy, uRect.zw, aXY), 0.0, 1.0); }`;
const PHOTO_FS = `precision mediump float; uniform sampler2D uTex; uniform float uDim; varying vec2 vUV;
void main() { gl_FragColor = vec4(texture2D(uTex, vUV).rgb * uDim, 1.0); }`;

/** Where a photo of size iw x ih sits when fitted (contain) into a canvas cw x ch: scale and offset in canvas pixels. */
export function fitPhoto(iw, ih, cw, ch) {
  const s = Math.min(cw / iw, ch / ih);
  return { s, ox: (cw - iw * s) / 2, oy: (ch - ih * s) / 2 };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = canvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: true }));
    if (!gl) throw new Error("WebGL is not available in this browser.");
    this.prog = {
      panel: this._program(PANEL_VS, PANEL_FS, ["aPos", "aUV", "aN"], ["uP0", "uP1", "uP2", "uSize", "uFar", "uEye", "uCull", "uTex", "uGain", "uBase", "uUseAlpha"]),
      line: this._program(LINE_VS, LINE_FS, ["aPos"], ["uP0", "uP1", "uP2", "uSize", "uFar", "uColor"]),
      photo: this._program(PHOTO_VS, PHOTO_FS, ["aXY"], ["uRect", "uTex", "uDim"]),
      mesh: this._program(MESH_VS, MESH_FS, ["aPos", "aN"], ["uP0", "uP1", "uP2", "uSize", "uFar", "uCol"]),
    };
    this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.screens = []; this.model = null; this.mesh = null; this.photoTex = null; this.photoSize = null; this.markers = [];
    this.bounds = { centre: [0, 0, 3], radius: 10 };
  }

  _program(vs, fs, attrs, unis) {
    const gl = this.gl, mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const out = { p, a: {}, u: {} };
    attrs.forEach((n) => (out.a[n] = gl.getAttribLocation(p, n))); unis.forEach((n) => (out.u[n] = gl.getUniformLocation(p, n)));
    return out;
  }

  _texture() {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  /** screens: [{ size:[W,H], panels:[{ uv:[[x,y]x4: TL,TR,BR,BL in screen pixels], pos, size:[w,h], normal, up }] }] */
  setScreens(screens) {
    const gl = this.gl; this.screens.forEach((s) => { gl.deleteBuffer(s.vbo); gl.deleteBuffer(s.outline); gl.deleteTexture(s.tex); });
    const all = [];
    this.screens = screens.map((sc) => {
      const W = sc.size[0], H = sc.size[1], tri = [], ol = [], cent = [];
      for (const p of sc.panels) {
        const n = norm(p.normal || [0, 0, -1]); let up = p.up ? norm(sub(p.up, mul(n, dot(p.up, n)))) : [0, 0, 1];
        const right = norm(cross(mul(n, -1), up)), hw = (p.size ? p.size[0] : 0.5) / 2, hh = (p.size ? p.size[1] : 0.5) / 2, c = p.pos;
        const C = [add(add(c, mul(right, -hw)), mul(up, hh)), add(add(c, mul(right, hw)), mul(up, hh)), add(add(c, mul(right, hw)), mul(up, -hh)), add(add(c, mul(right, -hw)), mul(up, -hh))];
        const T = p.uv.map((q) => [q[0] / W, q[1] / H]);
        for (const k of [0, 1, 2, 0, 2, 3]) tri.push(...C[k], ...T[k], ...n);
        for (let k = 0; k < 4; k++) ol.push(...C[k], ...C[(k + 1) % 4]);
        C.forEach((v) => all.push(v)); cent.push({ c, n });
      }
      const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tri), gl.STATIC_DRAW);
      const outline = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, outline); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ol), gl.STATIC_DRAW);
      return { vbo, outline, count: tri.length / 8, outlineCount: ol.length / 3, tex: this._texture(), source: null, size: [W, H], cent };
    });
    if (all.length) {
      const c = [0, 1, 2].map((k) => all.reduce((a, v) => a + v[k], 0) / all.length);
      this.bounds = { centre: c, radius: Math.max(1, ...all.map((v) => Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]))) };
    }
  }

  /** source: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement | { rgba: Uint8Array, w, h } | null */
  setContent(i, source, { dynamic = true, useAlpha = false, version = 0 } = {}) { const s = this.screens[i]; if (s) { if (s.source !== source || s.ver !== version) s.dirty = true; s.source = source; s.ver = version; s.dynamic = dynamic; s.useAlpha = useAlpha; } }

  setModel(segments) {
    const gl = this.gl; if (this.model) gl.deleteBuffer(this.model.vbo);
    if (!segments || !segments.length) { this.model = null; return; }
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segments.flat ? segments.flat() : segments), gl.STATIC_DRAW);
    this.model = { vbo, count: segments.length / 3 };
    const b = this.bounds; for (let i = 0; i < segments.length; i += 3) b.radius = Math.max(b.radius, Math.hypot(segments[i] - b.centre[0], segments[i + 1] - b.centre[1], segments[i + 2] - b.centre[2]) * 0.6);
  }

  /** Solid model: Float32Array, 6 floats per vertex (position, normal), 3 vertices per triangle. null clears it. */
  setMesh(tris) {
    const gl = this.gl; if (this.mesh) { gl.deleteBuffer(this.mesh.vbo); this.mesh = null; }
    if (!tris || !tris.length) return;
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, tris, gl.STATIC_DRAW); this.mesh = { vbo, count: tris.length / 6 };
  }

  setPhoto(img) {
    const gl = this.gl; if (this.photoTex) { gl.deleteTexture(this.photoTex); this.photoTex = null; }
    this.photoSize = null; if (!img) return;
    this.photoTex = this._texture(); gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.photoSize = [img.naturalWidth || img.width, img.naturalHeight || img.height];
  }

  resize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }

  _upload(s) {
    const gl = this.gl, src = s.source; if (!src || (!s.dirty && !s.dynamic)) return;
    if (src.rgba) { if (src.rgba !== s.lastData || s.dirty) { gl.bindTexture(gl.TEXTURE_2D, s.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, src.w, src.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.rgba); s.lastData = src.rgba; } }
    else if (!(src instanceof HTMLVideoElement) || src.readyState >= 2) { gl.bindTexture(gl.TEXTURE_2D, s.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
    s.dirty = false;
  }

  /** opts: { P (canvas pixel space), photoFit {s,ox,oy}|null, gain, dim, base, outline (panel outlines), model (wireframe), useAlpha, cull } */
  render(o) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height, P = o.P;
    gl.viewport(0, 0, W, H); gl.clearColor(0.039, 0.039, 0.035, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.colorMask(true, true, true, true);
    if (o.photoFit && this.photoTex) {
      const f = o.photoFit, pw = this.photoSize[0] * f.s, ph = this.photoSize[1] * f.s;
      const x0 = (f.ox / W) * 2 - 1, x1 = ((f.ox + pw) / W) * 2 - 1, y1 = 1 - (f.oy / H) * 2, y0 = 1 - ((f.oy + ph) / H) * 2, pr = this.prog.photo;
      gl.useProgram(pr.p); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad); gl.enableVertexAttribArray(pr.a.aXY); gl.vertexAttribPointer(pr.a.aXY, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(pr.u.uRect, x0, y0, x1, y1); gl.uniform1f(pr.u.uDim, o.dim == null ? 1 : o.dim); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.photoTex); gl.uniform1i(pr.u.uTex, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // far plane in camera-depth units: the farthest corner of anything we draw, with headroom
    let far = 1;
    const b = this.bounds, wc = project(P, b.centre)[2]; far = Math.max(1e-3, Math.abs(wc) + b.radius * 3);
    const eye = cameraCentre(P), U = (pr) => { gl.uniform4f(pr.u.uP0, P[0], P[1], P[2], P[3]); gl.uniform4f(pr.u.uP1, P[4], P[5], P[6], P[7]); gl.uniform4f(pr.u.uP2, P[8], P[9], P[10], P[11]); gl.uniform2f(pr.u.uSize, W, H); gl.uniform1f(pr.u.uFar, far); };
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    if (o.solid && this.mesh) {   // dark two-sided solid; it hides what is behind it, panels included, and pushes back a little so its own edges stay visible
      const ms = this.prog.mesh; gl.useProgram(ms.p); U(ms); gl.uniform3f(ms.u.uCol, 0.085, 0.085, 0.078);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.vbo);
      gl.enableVertexAttribArray(ms.a.aPos); gl.vertexAttribPointer(ms.a.aPos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(ms.a.aN); gl.vertexAttribPointer(ms.a.aN, 3, gl.FLOAT, false, 24, 12);
      gl.drawArrays(gl.TRIANGLES, 0, this.mesh.count); gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    const pn = this.prog.panel; gl.useProgram(pn.p); U(pn);
    gl.uniform3f(pn.u.uEye, eye ? eye[0] : 0, eye ? eye[1] : 0, eye ? eye[2] : 0); gl.uniform1f(pn.u.uCull, eye && o.cull !== false ? 1 : 0);
    gl.uniform1f(pn.u.uGain, o.gain == null ? 1 : o.gain); gl.uniform3f(pn.u.uBase, ...(o.base || [0.022, 0.022, 0.02])); gl.uniform1i(pn.u.uTex, 0);
    for (const pass of (o.noPanels ? [] : [0, 1])) {            // pass 0: depth only, so a panel hides the ones behind it; pass 1: add the light
      if (pass === 0) gl.colorMask(false, false, false, false); else { gl.colorMask(true, true, true, true); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); }
      for (const s of this.screens) {
        if (!s.count) continue; this._upload(s); gl.uniform1f(pn.u.uUseAlpha, s.useAlpha ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.tex); gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
        gl.enableVertexAttribArray(pn.a.aPos); gl.vertexAttribPointer(pn.a.aPos, 3, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(pn.a.aUV); gl.vertexAttribPointer(pn.a.aUV, 2, gl.FLOAT, false, 32, 12);
        gl.enableVertexAttribArray(pn.a.aN); gl.vertexAttribPointer(pn.a.aN, 3, gl.FLOAT, false, 32, 20);
        gl.drawArrays(gl.TRIANGLES, 0, s.count);
      }
    }
    gl.colorMask(true, true, true, true); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const ln = this.prog.line; gl.useProgram(ln.p); U(ln); gl.enableVertexAttribArray(ln.a.aPos);
    if (o.model && this.model) { gl.uniform4f(ln.u.uColor, 0.76, 0.75, 0.70, 0.34); gl.bindBuffer(gl.ARRAY_BUFFER, this.model.vbo); gl.vertexAttribPointer(ln.a.aPos, 3, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.LINES, 0, this.model.count); }
    gl.disable(gl.DEPTH_TEST);
    if (o.outline && !o.noPanels) for (const s of this.screens) { if (!s.outlineCount) continue; gl.uniform4f(ln.u.uColor, 1, 0.988, 0.976, 0.35); gl.bindBuffer(gl.ARRAY_BUFFER, s.outline); gl.vertexAttribPointer(ln.a.aPos, 3, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.LINES, 0, s.outlineCount); }
    gl.disable(gl.BLEND);
  }
}
