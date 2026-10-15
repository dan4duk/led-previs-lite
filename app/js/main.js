// previs-lite app: project loading, cameras (orbit and photo-matched), content sources, camera matching, full screen.
import { lookAtP, remapP, project, solveCamera, cameraCentre, cross, norm, sub, add, mul } from "./math.js";
import { parseOBJ, featureEdges, transformModel, guessUnits, guessUp, extents, UNITS } from "./obj.js";
import { Renderer, fitPhoto } from "./render.js";
import { TestPattern, fileSource, LiveClient } from "./content.js";

const $ = (id) => document.getElementById(id);
const dpr = () => Math.min(2, window.devicePixelRatio || 1, Math.sqrt(2.4e6 / Math.max(1, window.innerWidth * window.innerHeight)));   // ~2.4 megapixels at most
const S = { name: null, proj: null, cam: 0, gain: 1, dim: 1, outline: true, model: true, content: [], photos: new Map(), mode: "view", match: null, t0: performance.now(), server: true };
S.obj = null; S.modelMesh = null; S.modelSegs = null; S.flySpeed = 4;
const R = { main: null, ref: null, photo: null };
const COLORS = ["#99e836", "#e8493a", "#f6c453", "#5ec8ff", "#fffcf9", "#d58bff", "#ff8bd1", "#ff9d4d"];

// ---------------------------------------------------------------- small UI helpers
function seg(id, items, get, set) {
  const box = $(id); box.innerHTML = "";
  items.forEach(([v, label]) => { const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = label; b.dataset.v = String(v); b.onclick = () => { set(v); paint(); }; box.appendChild(b); });
  box._get = get; return box;
}
function paint() {
  document.querySelectorAll(".seg").forEach((box) => { if (box._get) { const cur = String(box._get()); box.querySelectorAll(".sb").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === cur))); } });
}
function toast(text, bad) {
  let t = $("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:200;padding:9px 16px;background:#151514;border:1px solid #363633;font:500 12px Manrope,system-ui,sans-serif;transition:opacity .3s"; document.body.appendChild(t); }
  t.textContent = text; t.style.color = bad ? "#e8493a" : "#fffcf9"; t.style.opacity = 1; clearTimeout(t._t); t._t = setTimeout(() => (t.style.opacity = 0), 3200);
}
function sizeCanvas(cv, ov) {
  const d = dpr(), w = Math.max(2, Math.round(cv.clientWidth * d)), h = Math.max(2, Math.round(cv.clientHeight * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  if (ov && (ov.width !== w || ov.height !== h)) { ov.width = w; ov.height = h; }
  return [w, h];
}

// ---------------------------------------------------------------- project
async function api(path, opts) { const r = await fetch(path, opts); if (!r.ok) throw new Error(path + " " + r.status); return r; }

async function init() {
  try { R.main = new Renderer($("cMain")); } catch (e) { $("msgMain").style.display = "block"; $("msgMain").textContent = e.message; return; }
  let list = { projects: [], live: false };
  try { list = await (await api("/api/projects")).json(); } catch (e) { S.server = false; }
  S.live = list.live;
  const sel = $("projSel"); sel.innerHTML = list.projects.map((p) => `<option>${p}</option>`).join("");
  if (!list.projects.length) { $("msgMain").style.display = "block"; $("msgMain").innerHTML = S.server ? "No projects yet.<br>Create one: <code>python3 previs.py new NAME --xml AdvancedOutput.xml</code>" : "Start the app with <code>python3 previs.py serve</code>."; return; }
  const want = new URLSearchParams(location.search).get("project");
  sel.value = list.projects.includes(want) ? want : list.projects[0];
  sel.onchange = () => loadProject(sel.value);
  await loadProject(sel.value);
  requestAnimationFrame(loop);
}

async function loadProject(name) {
  if (S.mode === "match") exitMatch();
  S.content.forEach((c) => c.live && c.live.client.close());
  S.name = name; S.proj = await (await api(`/projects/${encodeURIComponent(name)}/project.json`)).json();
  S.proj.cameras = S.proj.cameras && S.proj.cameras.length ? S.proj.cameras : [{ name: "Orbit", type: "orbit", target: [0, 0, 2], distance: 18, yaw: 35, pitch: 18, fov: 45 }];
  S.cam = 0; S.photos.clear();
  S.modelSegs = null; S.modelMesh = null; S.obj = null;
  const mdl = S.proj.model, mfile = mdl && (typeof mdl === "string" ? mdl : mdl.file);
  if (mfile) {
    try {
      const url = `/projects/${encodeURIComponent(name)}/${mfile}`;
      if (/\.obj$/i.test(mfile)) setObj(await (await api(url)).text(), mfile, typeof mdl === "object" ? mdl : {}, true);
      else S.modelSegs = Float32Array.from((await (await api(url)).json()).flat());
    } catch (e) { toast("Could not load the model: " + mfile, true); }
  }
  S.content = S.proj.screens.map((sc) => ({ mode: "test", test: new TestPattern(sc), file: null, live: null, status: "" }));
  [R.main, R.ref, R.photo].filter(Boolean).forEach(setupRenderer);
  const b = R.main.bounds; S.proj.cameras.forEach((c) => { if (c.type === "orbit" && c.target && c.distance == null) c.distance = b.radius * 2.2; });
  if (!S.proj.cameras.some((c) => c.type === "fly")) {   // a free-fly camera to walk around with WASD, standing in front and looking at the middle
    const c = b.centre, dist = Math.max(3, b.radius * 0.55), eh = 1.7;
    S.proj.cameras.push({ name: "Free fly", type: "fly", pos: [c[0], c[1] - dist, eh], yaw: 0, pitch: +Math.atan2(c[2] - eh, dist).toFixed(3), fov: 60 });
  }
  buildUI(); paint();
}
function setupRenderer(r) { r.setScreens(S.proj.screens); r.setModel(S.modelSegs); r.setMesh(solidOn() ? S.modelMesh : null); r._photoKey = null; }
const solidOn = () => !!(S.obj && S.obj.opts.display === "solid");

async function saveProject(quiet) {
  const text = JSON.stringify(S.proj, null, 1);
  try { await api(`/api/save?project=${encodeURIComponent(S.name)}`, { method: "POST", body: text }); if (!quiet) toast("Saved projects/" + S.name + "/project.json"); }
  catch (e) { if (quiet) return; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = "project.json"; a.click(); toast("No server to save to: downloaded project.json instead", true); }
}

// ---------------------------------------------------------------- cameras
function orbitEye(o) {
  const yaw = (o.yaw * Math.PI) / 180, pit = (o.pitch * Math.PI) / 180;
  return [o.target[0] + o.distance * Math.cos(pit) * Math.sin(yaw), o.target[1] - o.distance * Math.cos(pit) * Math.cos(yaw), o.target[2] + o.distance * Math.sin(pit)];
}
const orbitP = (o, W, H) => lookAtP(orbitEye(o), o.target, [0, 0, 1], o.fov || 45, W, H);

function getPhoto(path) {
  if (!path) return null; let e = S.photos.get(path);
  if (!e) { const img = new Image(); e = { img, ok: false }; img.onload = () => (e.ok = true); img.src = `/projects/${encodeURIComponent(S.name)}/${path}`; S.photos.set(path, e); }
  return e.ok ? e.img : null;
}

/** Mouse control for an orbit view: drag = orbit, shift/right/middle drag = pan, wheel = zoom. A left click without moving calls onClick. */
function orbitControl(el, getOrbit, onClick) {
  let drag = null;
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => { const o = getOrbit(); if (o) drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.shiftKey || e.button !== 0, button: e.button, o }; });
  window.addEventListener("mouseup", (e) => {
    if (!drag) return; const d = drag; drag = null;
    if (onClick && d.button === 0 && !d.pan && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) onClick(e);
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y, o = drag.o; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const yaw = (o.yaw * Math.PI) / 180, right = [Math.cos(yaw), Math.sin(yaw), 0], k = o.distance * 0.0016;
      o.target = [o.target[0] - right[0] * dx * k, o.target[1] - right[1] * dx * k, o.target[2] + dy * k];
    } else { o.yaw -= dx * 0.4; o.pitch = Math.max(-85, Math.min(88, o.pitch + dy * 0.4)); }
  });
  el.addEventListener("wheel", (e) => { const o = getOrbit(); if (!o) return; e.preventDefault(); o.distance = Math.max(0.5, o.distance * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
}

// ---------------------------------------------------------------- content
function bindContent(r) {
  S.content.forEach((c, i) => {
    if (c.mode === "test") r.setContent(i, c.test.canvas, { dynamic: true });
    else if (c.mode === "file" && c.file) { const e = c.file.el; r.setContent(i, e, { dynamic: c.file.kind === "video", version: c.file.kind === "image" ? (e.complete ? 1 : 0) : 0 }); }
    else if (c.mode === "live") { const f = c.live && c.live.client.frame; r.setContent(i, f || null, { dynamic: true, useAlpha: !!(f && f.alpha) }); }
  });
}
function setMode(i, mode) {
  const c = S.content[i]; c.mode = mode;
  if (mode === "live") {
    if (!c.live) {
      const sc = S.proj.screens[i], client = new LiveClient((m) => liveStatus(i, m)); c.live = { client, sources: [], current: null, info: "", fps: 0, text: "Connecting..." };
      client.open();
    }
  } else if (c.live) { c.live.client.select(null); }
  buildContentUI();
}
function liveStatus(i, m) {
  const c = S.content[i]; if (!c || !c.live) return; const L = c.live, sc = S.proj.screens[i];
  if (m.type === "closed") { L.text = "Bridge not running. Start it with: python3 previs.py serve --live"; L.sources = []; }
  else if (m.type === "connected") L.text = "Connected. Looking for NDI sources...";
  else if (m.type === "status") {
    L.sources = m.sources || []; L.current = m.current; L.info = m.info; L.fps = m.fps;
    if (!m.current && sc.ndi && c.mode === "live") { const hit = L.sources.find((n) => n.toLowerCase().includes(sc.ndi.toLowerCase())); if (hit) L.client.select(hit); }
    L.text = m.current ? `Receiving ${m.current} ${m.info} at ${m.fps} fps` : (L.sources.length ? "Pick an NDI source." : "No NDI sources yet. In Resolume: Preferences > Video > enable NDI output.");
  }
  buildContentUI(true);
}
function buildContentUI(keepFocus) {
  const box = $("contentBox"); box.innerHTML = "";
  S.proj.screens.forEach((sc, i) => {
    const c = S.content[i], d = document.createElement("div"); d.className = "scr";
    d.innerHTML = `<b></b><small>${sc.size[0]}&times;${sc.size[1]} px, ${sc.panels.length} panels</small><div class="seg"></div><div class="status"></div><div class="seg srcs" style="margin-top:6px"></div>`;
    d.querySelector("b").textContent = sc.name;
    const modes = d.querySelector(".seg");
    [["test", "Test pattern"], ["file", "Video / image"], ["live", "Live NDI"]].forEach(([m, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = label; b.setAttribute("aria-pressed", String(c.mode === m));
      b.onclick = () => { if (m === "file" && !c.file) pickFile(i); else setMode(i, m); }; modes.appendChild(b);
    });
    const st = d.querySelector(".status");
    st.textContent = c.mode === "live" && c.live ? c.live.text : c.mode === "file" && c.file ? "File: " + c.file.name : c.mode === "test" ? "Built-in test pattern" : "";
    if (c.mode === "file" && c.file) { const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = "Choose another..."; b.onclick = () => pickFile(i); d.querySelector(".srcs").appendChild(b); }
    if (c.mode === "live" && c.live) c.live.sources.forEach((n) => { const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = n; b.setAttribute("aria-pressed", String(n === c.live.current)); b.onclick = () => c.live.client.select(n); d.querySelector(".srcs").appendChild(b); });
    box.appendChild(d);
  });
}
function pickFile(i) {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "video/*,image/*";
  inp.onchange = () => { if (inp.files[0]) { const c = S.content[i]; if (c.file) URL.revokeObjectURL(c.file.url); c.file = fileSource(inp.files[0]); setMode(i, "file"); } };
  inp.click();
}

// ---------------------------------------------------------------- UI build
function buildUI() {
  seg("gGain", [[0.5, "50%"], [1, "100%"], [1.5, "150%"], [2, "200%"], [3, "300%"]], () => S.gain, (v) => (S.gain = v));
  seg("gDim", [[1, "100%"], [0.7, "70%"], [0.45, "45%"], [0.25, "25%"], [0, "Off"]], () => S.dim, (v) => (S.dim = v));
  const sh = $("gShow"); sh.innerHTML = "";
  [["outline", "Panel outlines"], ["model", "Model lines"]].forEach(([k, label]) => { const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = label; b.onclick = () => { S[k] = !S[k]; b.setAttribute("aria-pressed", String(S[k])); }; b.setAttribute("aria-pressed", String(S[k])); sh.appendChild(b); });
  seg("gFly", [[1.5, "Slow"], [4, "Normal"], [10, "Fast"]], () => { const v = [1.5, 4, 10].find((x) => Math.abs(S.flySpeed - x) / x < 0.2); return v || 0; }, (v) => (S.flySpeed = v));
  buildCamUI(); buildContentUI(); buildModelUI();
  $("help").innerHTML = `Keys: <b>1&ndash;9</b> camera, <b>F</b> full screen, <b>M</b> match camera.<br>Drag to orbit, shift-drag to pan, wheel to zoom (orbit cameras).<br>Project folder: <code>projects/${S.name}/</code>`;
}
function buildCamUI() {
  const cams = S.proj.cameras, tabs = $("camTabs"); tabs.innerHTML = ""; $("fsBar").innerHTML = "";
  [tabs, $("fsBar")].forEach((host) => cams.forEach((c, i) => { const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = c.name; b.dataset.cam = i; b.onclick = () => selectCam(i); host.appendChild(b); }));
  [[1.5, "Slow"], [4, "Normal"], [10, "Fast"]].forEach(([v, label]) => { const b = document.createElement("button"); b.type = "button"; b.className = "sb"; b.textContent = label; b.title = "Fly speed (Shift = 3x, wheel adjusts)"; b.dataset.fly = v; b.onclick = () => { S.flySpeed = v; }; $("fsBar").appendChild(b); });
  const ex = document.createElement("button"); ex.type = "button"; ex.className = "sb"; ex.textContent = "Exit ✕"; ex.onclick = () => document.exitFullscreen && document.fullscreenElement ? document.exitFullscreen() : toggleFS(); $("fsBar").appendChild(ex);
  const list = $("camList"); list.innerHTML = "";
  cams.forEach((c, i) => {
    const row = document.createElement("div"); row.className = "cam";
    const st = c.type === "orbit" ? ["orbit", ""] : c.type === "fly" ? ["fly: WASD", ""] : c.P ? [`matched, ${c.rms != null ? c.rms.toFixed(1) + " px" : "ok"}`, "ok"] : ["not matched yet", "warn"];
    row.innerHTML = `<div>${c.name} <span class="st ${st[1]}">${st[0]}</span></div><div></div>`;
    const act = row.lastChild;
    if (c.type === "photo") { const m = document.createElement("button"); m.textContent = c.P ? "Re-match" : "Match"; m.onclick = () => { S.cam = i; enterMatch(); }; act.appendChild(m); }
    if (cams.length > 1) { const x = document.createElement("button"); x.textContent = "✕"; x.title = "Remove camera"; x.onclick = () => { if (confirm("Remove camera '" + c.name + "'?")) { cams.splice(i, 1); S.cam = Math.min(S.cam, cams.length - 1); buildCamUI(); paint(); } }; act.appendChild(x); }
    list.appendChild(row);
  });
  paint2();
}
function paint2() {
  document.querySelectorAll("[data-cam]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.cam === S.cam)));
  const cam = S.proj && S.proj.cameras[S.cam], fly = !!(cam && cam.type === "fly" && S.mode === "view");
  const fb = $("flyBox"); if (fb) fb.hidden = !fly;
  document.querySelectorAll("#fsBar [data-fly]").forEach((b) => { b.hidden = !fly; b.setAttribute("aria-pressed", String(Math.abs(S.flySpeed - +b.dataset.fly) / +b.dataset.fly < 0.2)); });
  const h = $("fsHint"); if (h && cam) h.textContent = S.name + " \u00b7 " + cam.name + (fly ? "   WASD move \u00b7 Q/E down/up \u00b7 look: right-drag or click \u00b7 Shift fast \u00b7 wheel speed \u00b7 Esc" : "");
}
function selectCam(i) {
  if (S.mode === "match") return;
  const prev = S.proj.cameras[S.cam], cam = S.proj.cameras[i];
  if (cam.type === "fly" && prev && prev !== cam) { const d = camPose(prev); if (d) { cam.pos = d.eye; cam.yaw = Math.atan2(d.dir[0], d.dir[1]); cam.pitch = Math.asin(Math.max(-1, Math.min(1, d.dir[2]))); } }
  S.cam = i; paint2();
}
function camPose(cam) {   // where a camera is and which way it looks, in world space
  if (cam.type === "orbit") { const eye = orbitEye(cam); return { eye, dir: norm(sub(cam.target, eye)) }; }
  if (cam.type === "photo" && cam.P) { const c = cameraCentre(cam.P); if (c) return { eye: c, dir: norm([cam.P[8], cam.P[9], cam.P[10]]) }; }
  return null;
}

// ---------------------------------------------------------------- rendering loop
function loop(now) {
  const t = (now - S.t0) / 1000;
  S.content.forEach((c) => c.mode === "test" && c.test.tick(t));
  try { if (S.mode === "match") drawMatch(); else drawMain(); } catch (e) { console.error(e); }
  paint2(); requestAnimationFrame(loop);
}
function syncPhoto(r, img, key) { if (r._photoKey !== key) { r.setPhoto(img); r._photoKey = key; } }

function drawMain() {
  const [W, H] = sizeCanvas($("cMain"), $("oMain")), cam = S.proj.cameras[S.cam], msg = $("msgMain");
  R.main.resize(W, H); bindContent(R.main);
  let P, fit = null, noPanels = false, text = "";
  if (cam.type === "photo") {
    const img = getPhoto(cam.photo); syncPhoto(R.main, img, img ? cam.photo : null);
    if (img) fit = fitPhoto(img.naturalWidth, img.naturalHeight, W, H);
    if (cam.P && fit) P = remapP(cam.P, fit.s, fit.ox, fit.oy); else { P = lookAtP([0, -10, 2], [0, 0, 2], [0, 0, 1], 45, W, H); noPanels = true; text = img ? "This photo is not matched yet.<br>Press <b>Match camera</b>." : "Loading photo..."; }
  } else if (cam.type === "fly") { syncPhoto(R.main, null, null); P = flyP(cam, W, H); }
  else { syncPhoto(R.main, null, null); P = orbitP(cam, W, H); }
  msg.style.display = text ? "block" : "none"; if (text) msg.innerHTML = text;
  R.main.render({ P, photoFit: fit, gain: S.gain, dim: S.dim, outline: S.outline, model: S.model, noPanels, solid: cam.type !== "photo" });
}
orbitControl($("oMain"), () => (S.mode === "view" && S.proj.cameras[S.cam].type === "orbit" ? S.proj.cameras[S.cam] : null));

// ---------------------------------------------------------------- camera matching
function candidates() {
  const pts = [], seen = new Set(), add3 = (p) => { const k = p.map((v) => Math.round(v * 100)).join(","); if (!seen.has(k)) { seen.add(k); pts.push(p); } };
  for (const s of S.proj.screens) for (const p of s.panels) {
    const n = norm(p.normal || [0, 0, -1]); const up = p.up ? norm(sub(p.up, mul(n, p.up[0] * n[0] + p.up[1] * n[1] + p.up[2] * n[2]))) : [0, 0, 1];
    const right = norm(cross(mul(n, -1), up)), hw = (p.size ? p.size[0] : 0.5) / 2, hh = (p.size ? p.size[1] : 0.5) / 2;
    [[-1, 1], [1, 1], [1, -1], [-1, -1]].forEach(([a, b]) => add3(add(add(p.pos, mul(right, a * hw)), mul(up, b * hh))));
  }
  if (S.modelSegs) for (let i = 0; i < S.modelSegs.length; i += 3) add3([S.modelSegs[i], S.modelSegs[i + 1], S.modelSegs[i + 2]]);
  return pts;
}
function enterMatch() {
  const cam = S.proj.cameras[S.cam]; if (!cam || cam.type !== "photo") { toast("Add a photo first (+ Add photo of the space), then match it.", true); return; }
  try { R.ref = R.ref || new Renderer($("cRef")); R.photo = R.photo || new Renderer($("cPhoto")); } catch (e) { toast(e.message, true); return; }
  setupRenderer(R.ref); setupRenderer(R.photo);
  const b = R.main.bounds, M = (S.match = {
    cam, pairs: (cam.pairs || []).map((p) => ({ world: p.world.slice(), image: p.image.slice() })), pending: null, hover: null, sol: null, cands: candidates(), drag: null, spaceDown: false,
    orbit: { target: b.centre.slice(), distance: b.radius * 1.5, yaw: 25, pitch: -8, fov: 45 }, view: { zoom: 1, px: 0, py: 0 },
  });
  S.mode = "match"; $("viewMain").hidden = true; $("viewMatch").hidden = false; $("matchBar").hidden = false; $("matchBtn").textContent = "Leave matching";
  resolve(); buildMatchBar();
}
function exitMatch() {
  S.mode = "view"; S.match = null; $("viewMain").hidden = false; $("viewMatch").hidden = true; $("matchBar").hidden = true; $("matchBtn").textContent = "Match camera"; buildCamUI(); paint();
}
function resolve() {
  const M = S.match; M.sol = null; M.err = ""; if (M.pairs.length < 4) return;
  const r = solveCamera(M.pairs.map((p) => p.world), M.pairs.map((p) => p.image)); if (r.error) M.err = r.error; else M.sol = r;
}
function buildMatchBar() {
  const M = S.match, bar = $("matchBar"), n = M.pairs.length;
  let info;
  if (M.sol) info = `<b class="${M.sol.rms < 3 ? "ok" : M.sol.rms < 8 ? "" : "bad"}">${M.sol.rms.toFixed(1)} px</b> typical error, ${M.sol.max.toFixed(1)} px worst &middot; ${M.sol.mode} &middot; ${n} pairs`;
  else info = M.pending ? "Now click the <b>same point in the photo</b>." : n >= 4 ? M.err : `${n} pair${n === 1 ? "" : "s"}. Click a point in the 3D model, then the same point in the photo. Spread points across the whole view and at different heights (need 6; 4 if they are all on one flat surface).`;
  bar.innerHTML = `<div class="info">${info}</div><div class="chips"></div>`;
  const chips = bar.querySelector(".chips");
  M.pairs.forEach((p, i) => { const c = document.createElement("span"); c.className = "chip"; c.style.borderColor = COLORS[i % 8]; c.innerHTML = `#${i + 1}<button title="Remove this pair">&times;</button>`; c.querySelector("button").onclick = () => { M.pairs.splice(i, 1); resolve(); buildMatchBar(); }; chips.appendChild(c); });
  const add = (label, fn, cls = "alt", dis = false) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls; b.textContent = label; b.disabled = dis; b.onclick = fn; bar.appendChild(b); };
  add("Undo", () => { if (M.pending) M.pending = null; else M.pairs.pop(); resolve(); buildMatchBar(); }, "alt", !n && !M.pending);
  add("Clear all", () => { M.pairs = []; M.pending = null; resolve(); buildMatchBar(); }, "alt", !n);
  add("Reset photo view", () => (M.view = { zoom: 1, px: 0, py: 0 }));
  add("Apply camera", () => applyMatch(), "", !M.sol);
  add("Cancel", () => exitMatch());
}
function applyMatch() {
  const M = S.match, c = M.cam; c.P = M.sol.P; c.rms = M.sol.rms; c.pairs = M.pairs.map((p) => ({ world: p.world, image: p.image.map((v) => Math.round(v * 10) / 10) }));
  const img = getPhoto(c.photo); if (img) c.size = [img.naturalWidth, img.naturalHeight];
  exitMatch(); selectCam(S.proj.cameras.indexOf(c)); saveProject();
}
function photoFitFor(W, H) {
  const M = S.match, img = getPhoto(M.cam.photo); if (!img) return null; const b = fitPhoto(img.naturalWidth, img.naturalHeight, W, H), z = M.view.zoom;
  return { s: b.s * z, ox: W / 2 - (W / 2 - b.ox) * z + M.view.px, oy: H / 2 - (H / 2 - b.oy) * z + M.view.py, img };
}
function drawMatch() {
  const M = S.match, [W1, H1] = sizeCanvas($("cRef"), $("oRef")), [W2, H2] = sizeCanvas($("cPhoto"), $("oPhoto"));
  R.ref.resize(W1, H1); R.photo.resize(W2, H2); bindContent(R.ref); bindContent(R.photo);
  const refP = orbitP(M.orbit, W1, H1);
  R.ref.render({ P: refP, gain: S.gain, outline: true, model: true, solid: true });
  const fit = photoFitFor(W2, H2); syncPhoto(R.photo, fit && fit.img, fit ? M.cam.photo : null);
  const photoP = M.sol && fit ? remapP(M.sol.P, fit.s, fit.ox, fit.oy) : lookAtP([0, -10, 2], [0, 0, 2], [0, 0, 1], 45, W2, H2);
  R.photo.render({ P: photoP, photoFit: fit, gain: S.gain, dim: S.dim, outline: true, model: S.model, noPanels: !M.sol });
  // overlays
  const o1 = $("oRef").getContext("2d"), o2 = $("oPhoto").getContext("2d"); o1.clearRect(0, 0, W1, H1); o2.clearRect(0, 0, W2, H2);
  const ring = (ctx, x, y, col, r, label) => { ctx.lineWidth = 2.5 * dpr(); ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(x, y, r * dpr(), 0, 7); ctx.stroke(); if (label) { ctx.fillStyle = col; ctx.font = `${12 * dpr()}px system-ui`; ctx.fillText(label, x + (r + 3) * dpr(), y - (r + 1) * dpr()); } };
  if (M.hover) { const q = project(refP, M.hover); if (q[2] > 0) ring(o1, q[0], q[1], "rgba(255,255,255,.85)", 7); }
  M.pairs.forEach((p, i) => {
    const col = COLORS[i % 8], q = project(refP, p.world); if (q[2] > 0) ring(o1, q[0], q[1], col, 8, "" + (i + 1));
    if (fit) { const x = fit.ox + p.image[0] * fit.s, y = fit.oy + p.image[1] * fit.s; ring(o2, x, y, col, 8, "" + (i + 1));
      if (M.sol) { const r = project(photoP, p.world); if (r[2] > 0) { o2.strokeStyle = col; o2.lineWidth = 1.5 * dpr(); o2.beginPath(); o2.moveTo(x, y); o2.lineTo(r[0], r[1]); o2.stroke(); o2.fillStyle = col; o2.fillRect(r[0] - 2 * dpr(), r[1] - 2 * dpr(), 4 * dpr(), 4 * dpr()); } } }
  });
  if (M.pending) { const q = project(refP, M.pending); if (q[2] > 0) ring(o1, q[0], q[1], "#fff", 11); }
}
function nearestCandidate(e) {
  const M = S.match, el = $("oRef"), r = el.getBoundingClientRect(), d = dpr(), x = (e.clientX - r.left) * d, y = (e.clientY - r.top) * d, P = orbitP(M.orbit, el.width, el.height);
  let best = null, bd = 16 * d; for (const c of M.cands) { const q = project(P, c); if (q[2] <= 0) continue; const dist = Math.hypot(q[0] - x, q[1] - y); if (dist < bd) { bd = dist; best = c; } } return best;
}
orbitControl($("oRef"), () => (S.match ? S.match.orbit : null), (e) => {
  const M = S.match, c = nearestCandidate(e); if (!c) return;
  if (M.pairs.some((p) => p.world[0] === c[0] && p.world[1] === c[1] && p.world[2] === c[2])) { toast("That point is already used.", true); return; }
  M.pending = c; buildMatchBar();
});
$("oRef").addEventListener("mousemove", (e) => { if (S.match && !(e.buttons & 1)) S.match.hover = nearestCandidate(e); });
$("oRef").addEventListener("mouseleave", () => { if (S.match) S.match.hover = null; });

// photo view: click to place, drag a marker to refine, wheel to zoom, right/middle/shift drag to pan
(function () {
  const el = $("oPhoto"); let drag = null;
  const pos = (e) => { const r = el.getBoundingClientRect(), d = dpr(); return [(e.clientX - r.left) * d, (e.clientY - r.top) * d]; };
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => {
    const M = S.match; if (!M) return; const [x, y] = pos(e), fit = photoFitFor(el.width, el.height); if (!fit) return;
    if (e.button !== 0 || e.shiftKey) { drag = { pan: true, x, y }; return; }
    const hit = M.pairs.findIndex((p) => Math.hypot(fit.ox + p.image[0] * fit.s - x, fit.oy + p.image[1] * fit.s - y) < 12 * dpr());
    drag = hit >= 0 ? { idx: hit, moved: false } : { place: true, x, y };
  });
  window.addEventListener("mousemove", (e) => {
    const M = S.match; if (!M || !drag) return; const [x, y] = pos(e), fit = photoFitFor(el.width, el.height);
    if (drag.pan) { M.view.px += x - drag.x; M.view.py += y - drag.y; drag.x = x; drag.y = y; }
    else if (drag.idx != null && fit) { M.pairs[drag.idx].image = [(x - fit.ox) / fit.s, (y - fit.oy) / fit.s]; drag.moved = true; resolve(); }
  });
  window.addEventListener("mouseup", (e) => {
    const M = S.match; if (!M || !drag) return; const [x, y] = pos(e), fit = photoFitFor(el.width, el.height), d = drag; drag = null;
    if (d.place && M.pending && fit && Math.hypot(x - d.x, y - d.y) < 5) { M.pairs.push({ world: M.pending, image: [(x - fit.ox) / fit.s, (y - fit.oy) / fit.s] }); M.pending = null; resolve(); buildMatchBar(); }
    else if (d.idx != null) buildMatchBar();
    else if (d.place && !M.pending && Math.hypot(x - d.x, y - d.y) < 5) toast("First click a point on the 3D model (left), then the same point here.");
  });
  el.addEventListener("wheel", (e) => {
    const M = S.match; if (!M) return; e.preventDefault(); const [x, y] = pos(e), fit = photoFitFor(el.width, el.height); if (!fit) return;
    const ix = (x - fit.ox) / fit.s, iy = (y - fit.oy) / fit.s, nz = Math.max(1, Math.min(12, M.view.zoom * Math.exp(-e.deltaY * 0.0015))); M.view.zoom = nz;
    const f2 = photoFitFor(el.width, el.height); M.view.px += x - (f2.ox + ix * f2.s); M.view.py += y - (f2.oy + iy * f2.s);
  }, { passive: false });
})();

// ---------------------------------------------------------------- photos, full screen, screenshot, keys
async function addPhoto(file) {
  if (!S.proj) return; if (!/^image\//.test(file.type)) { toast("That is not an image.", true); return; }
  let path = null;
  try { const r = await api(`/api/upload?project=${encodeURIComponent(S.name)}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: await file.arrayBuffer() }); path = (await r.json()).path; }
  catch (e) { toast("Could not upload the photo to the project folder.", true); return; }
  const base = file.name.replace(/\.[^.]+$/, ""), cam = { name: base.slice(0, 22), type: "photo", photo: path, size: [0, 0], P: null };
  S.photos.delete(path); S.proj.cameras.push(cam); S.cam = S.proj.cameras.length - 1; buildCamUI(); paint();
  await new Promise((r) => { const t = setInterval(() => { if (getPhoto(path)) { clearInterval(t); r(); } }, 60); });
  cam.size = [getPhoto(path).naturalWidth, getPhoto(path).naturalHeight]; enterMatch();
}
$("addPhoto").onclick = () => $("photoFile").click();
$("photoFile").onchange = (e) => { if (e.target.files[0]) addPhoto(e.target.files[0]); e.target.value = ""; };
["dragover", "dragenter"].forEach((ev) => $("stage").addEventListener(ev, (e) => { e.preventDefault(); $("stage").classList.add("drop"); }));
["dragleave", "drop"].forEach((ev) => $("stage").addEventListener(ev, () => $("stage").classList.remove("drop")));
$("stage").addEventListener("drop", (e) => {
  e.preventDefault(); const files = [...e.dataTransfer.files], obj = files.find((x) => /\.obj$/i.test(x.name)), img = files.find((x) => /^image\//.test(x.type));
  if (obj) importModel(obj); else if (img) addPhoto(img); else if (files.length) toast("Drop a photo (jpg, png) or a 3D model (.obj).", true);
});

let idleT = null;
function wake() { const st = $("stage"); st.classList.remove("idle"); clearTimeout(idleT); if (document.fullscreenElement || st.classList.contains("fs")) idleT = setTimeout(() => st.classList.add("idle"), 3500); }
function toggleFS() {
  const st = $("stage");
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (st.classList.contains("fs")) { st.classList.remove("fs", "idle"); return; }
  if (S.mode === "match") { toast("Leave matching first.", true); return; }
  st.requestFullscreen ? st.requestFullscreen().catch(() => { st.classList.add("fs"); wake(); }) : (st.classList.add("fs"), wake()); wake();
}
$("fsBtn").onclick = toggleFS; $("stage").addEventListener("mousemove", wake); document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) $("stage").classList.remove("idle"); else wake(); });
$("shotBtn").onclick = () => { if (S.mode !== "view") return; $("cMain").toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `previs-${S.proj.cameras[S.cam].name.replace(/\W+/g, "_")}.png`; a.click(); }); };
$("saveBtn").onclick = saveProject;
$("matchBtn").onclick = () => (S.mode === "match" ? exitMatch() : enterMatch());
document.addEventListener("keydown", (e) => {
  const t = e.target && e.target.tagName; if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey || !S.proj) return;
  if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFS(); }
  else if (e.key === "m" || e.key === "M") { S.mode === "match" ? exitMatch() : enterMatch(); }
  else if (e.key === "Escape" && S.mode === "match") exitMatch();
  else if (e.key === "Escape" && $("stage").classList.contains("fs") && !document.pointerLockElement) toggleFS();
  else if (e.key >= "1" && e.key <= "9" && S.mode === "view" && S.proj.cameras[+e.key - 1]) selectCam(+e.key - 1);
  else if ((e.key === "Backspace" || e.key === "z") && S.mode === "match") { const M = S.match; if (M.pending) M.pending = null; else M.pairs.pop(); resolve(); buildMatchBar(); }
});

// ---------------------------------------------------------------- 3D model: import a .obj (drop it on the view or choose it), then fix units / up axis / placement
function setObj(text, file, saved, quiet) {
  const parsed = parseOBJ(text);
  if (!parsed.tris.length && !parsed.lines.length) throw new Error("No faces or lines found in that OBJ.");
  S.obj = { file, parsed, edges: featureEdges(parsed), guessed: !saved.units,
    opts: { units: saved.units || guessUnits(parsed.pos), up: saved.up || guessUp(parsed.pos), rot: saved.rot || 0, place: saved.place || "asis", display: saved.display || "lines" } };
  rebuildObj();
}
function rebuildObj() {
  const t = transformModel(S.obj.parsed, S.obj.edges, S.obj.opts);
  S.modelSegs = t.segments; S.modelMesh = t.mesh; S.obj.size = t.size; S.obj.lo = t.lo; S.obj.hi = t.hi; S.obj.tris = S.obj.parsed.tris.length / 3;
  S.proj.model = Object.assign({ file: S.obj.file, format: "obj" }, S.obj.opts);
  [R.main, R.ref, R.photo].filter(Boolean).forEach((r) => { r.setModel(S.modelSegs); r.setMesh(solidOn() ? S.modelMesh : null); });
  if (S.match) S.match.cands = candidates();
  buildModelUI();
}
function schedSave() { clearTimeout(S._st); S._st = setTimeout(() => saveProject(true), 700); }
function frameModel() {   // point the current camera at the new model
  const c = S.proj.cameras[S.cam], o = S.obj; if (!c || !o) return;
  const ctr = [0, 1, 2].map((k) => (o.lo[k] + o.hi[k]) / 2), big = Math.max(...o.size);
  if (c.type === "orbit") { c.target = ctr; c.distance = big * 1.3; }
  else if (c.type === "fly") { c.pos = [ctr[0], ctr[1] - big * 0.9, Math.min(1.7, ctr[2])]; c.yaw = 0; c.pitch = 0.1; }
}
async function importModel(file) {
  if (!S.proj) return; if (!/\.obj$/i.test(file.name)) { toast("That is not an .obj file.", true); return; }
  toast("Reading " + file.name + "...");
  let text, path;
  try { text = await file.text(); } catch (e) { toast("Could not read that file.", true); return; }
  try { const r = await api(`/api/upload?project=${encodeURIComponent(S.name)}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: text }); path = (await r.json()).path; }
  catch (e) { toast("Could not copy the model into the project folder. Is the server running?", true); return; }
  try { setObj(text, path, {}); } catch (e) { toast(e.message, true); return; }
  frameModel(); saveProject(true);
  const o = S.obj.opts, z = S.obj.size;
  toast(`Imported ${file.name}: ${Math.round(S.obj.tris).toLocaleString()} triangles, ${z.map((v) => v.toFixed(1)).join(" x ")} m. Units (${o.units}) and up axis (${o.up.toUpperCase()}) were guessed: fix them under 3D model if it looks wrong.`);
}
function buildModelUI() {
  const box = $("modelBox"); if (!box) return; box.innerHTML = ""; const o = S.obj;
  if (!o) {
    const m = S.proj && S.proj.model, f = m && (typeof m === "string" ? m : m.file);
    box.innerHTML = `<div class="status" style="margin:0 0 8px">${f ? "<b>" + f + "</b> (line segments)" : "No 3D model yet."}</div><button id="modelPick" class="btn alt" type="button">Import .obj…</button><p class="note">Or drop a <b>.obj</b> file on the view. You can fix units, up axis and placement afterwards.</p>`;
    $("modelPick").onclick = () => $("modelFile").click(); return;
  }
  box.innerHTML = `<div class="status" id="modelInfo" style="margin:0 0 6px"></div><span class="lab">Units in the file</span><div id="gMUnits" class="seg"></div><span class="lab">Up axis</span><div id="gMUp" class="seg"></div>
    <span class="lab">Rotate</span><div id="gMRot" class="seg"></div><span class="lab">Place</span><div id="gMPlace" class="seg"></div><span class="lab">Show</span><div id="gMShow" class="seg"></div>
    <div class="seg" style="margin-top:10px"><button id="modelPick" class="sb" type="button">Replace .obj…</button><button id="modelDel" class="sb" type="button">Remove</button></div>`;
  $("modelInfo").textContent = `${o.file.split("/").pop()} · ${Math.round(o.tris).toLocaleString()} triangles · ${o.size.map((v) => v.toFixed(1)).join(" × ")} m`;
  const set = (k) => (v) => { o.opts[k] = v; o.guessed = false; rebuildObj(); schedSave(); };
  seg("gMUnits", Object.keys(UNITS).map((u) => [u, u]), () => o.opts.units, set("units"));
  seg("gMUp", [["z", "Z up"], ["y", "Y up"]], () => o.opts.up, set("up"));
  seg("gMRot", [[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], () => o.opts.rot, set("rot"));
  seg("gMPlace", [["asis", "As exported"], ["floor", "On floor"], ["centre", "Centre + floor"]], () => o.opts.place, set("place"));
  seg("gMShow", [["lines", "Lines"], ["solid", "Solid"]], () => o.opts.display, set("display"));
  $("modelPick").onclick = () => $("modelFile").click();
  $("modelDel").onclick = () => { if (!confirm("Remove the model from this project? (The .obj file stays in the project folder.)")) return; S.obj = null; S.modelSegs = null; S.modelMesh = null; S.proj.model = null; [R.main, R.ref, R.photo].filter(Boolean).forEach((r) => { r.setModel(null); r.setMesh(null); }); buildModelUI(); saveProject(true); };
  paint();
}
$("modelFile").onchange = (e) => { if (e.target.files[0]) importModel(e.target.files[0]); e.target.value = ""; };

// ---------------------------------------------------------------- free-fly camera: WASD + Q/E to move, mouse to look (like the Unreal editor)
const flyDir = (c) => [Math.sin(c.yaw) * Math.cos(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch)];
function flyP(c, W, H) { const d = flyDir(c); return lookAtP(c.pos, [c.pos[0] + d[0], c.pos[1] + d[1], c.pos[2] + d[2]], [0, 0, 1], c.fov || 60, W, H); }
const FLYKEYS = {}, LOOK = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }; let flyLast = performance.now(), flyDrag = null;
function activeFly() { const c = S.proj && S.proj.cameras[S.cam]; return c && c.type === "fly" && S.mode === "view" ? c : null; }
function flyTick(now) {
  const dt = Math.min(0.25, (now - flyLast) / 1000); flyLast = now; const c = activeFly();
  if (c) {
    const f = flyDir(c), r = [Math.cos(c.yaw), -Math.sin(c.yaw), 0], k = FLYKEYS, sp = S.flySpeed * (k.ShiftLeft || k.ShiftRight ? 3 : 1) * dt;
    const fw = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), st = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0), ud = (k.KeyE ? 1 : 0) - (k.KeyQ ? 1 : 0);
    for (let i = 0; i < 3; i++) c.pos[i] += (f[i] * fw + r[i] * st) * sp;
    c.pos[2] += ud * sp;
    for (const code in LOOK) if (k[code]) { c.yaw += LOOK[code][0] * 1.6 * dt; c.pitch = Math.max(-1.5, Math.min(1.5, c.pitch + LOOK[code][1] * 1.2 * dt)); }
  }
  requestAnimationFrame(flyTick);
}
function look(c, dx, dy) { c.yaw += dx * 0.0032; c.pitch = Math.max(-1.5, Math.min(1.5, c.pitch - dy * 0.0032)); }
window.addEventListener("keydown", (e) => {
  const t = e.target && e.target.tagName; if (!activeFly() || t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(Key[WASDQE]|Shift(Left|Right)|Arrow(Left|Right|Up|Down))$/.test(e.code)) { FLYKEYS[e.code] = true; if (e.code.indexOf("Arrow") === 0) e.preventDefault(); }
});
window.addEventListener("keyup", (e) => { delete FLYKEYS[e.code]; });
window.addEventListener("blur", () => { for (const k in FLYKEYS) delete FLYKEYS[k]; });
(function () {
  const el = $("oMain");
  el.addEventListener("contextmenu", (e) => { if (activeFly()) e.preventDefault(); });
  el.addEventListener("mousedown", (e) => { if (activeFly() && e.button === 2) { flyDrag = { x: e.clientX, y: e.clientY }; e.preventDefault(); } });
  window.addEventListener("mouseup", (e) => { if (e.button === 2) flyDrag = null; });
  window.addEventListener("mousemove", (e) => {
    const c = activeFly(); if (!c) return;
    if (document.pointerLockElement === el) look(c, e.movementX, e.movementY);
    else if (flyDrag) { look(c, e.clientX - flyDrag.x, e.clientY - flyDrag.y); flyDrag.x = e.clientX; flyDrag.y = e.clientY; }
  });
  el.addEventListener("click", (e) => { if (activeFly() && e.button === 0 && !document.pointerLockElement && el.requestPointerLock) { try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (x) {} } });
  el.addEventListener("wheel", (e) => { if (activeFly()) { e.preventDefault(); S.flySpeed = Math.max(0.4, Math.min(30, S.flySpeed * Math.exp(-e.deltaY * 0.0012))); } }, { passive: false });
})();
requestAnimationFrame(flyTick);

window.previs = { S, R };   // handy for debugging and automated tests from the console
init().catch((e) => { console.error(e); toast(String(e.message || e), true); });
