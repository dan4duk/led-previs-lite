// Content sources for a screen: a built-in test pattern, a video/image file, or live NDI frames from the bridge (previs.py --live).

/** Animated test pattern drawn on the screen's pixel map: coloured panels with their ids, a running highlight and a sweep. */
export class TestPattern {
  constructor(screen) {
    this.screen = screen; const W = screen.size[0], H = screen.size[1];
    this.k = Math.min(1, 1536 / W); this.canvas = document.createElement("canvas"); this.canvas.width = Math.round(W * this.k); this.canvas.height = Math.round(H * this.k);
    this.ctx = this.canvas.getContext("2d");
  }
  tick(t) {
    const { ctx, canvas, k, screen } = this, W = canvas.width, H = canvas.height, n = screen.panels.length, head = Math.floor(t * 6) % Math.max(1, n);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    screen.panels.forEach((p, i) => {
      const hue = (i * 360 / Math.max(1, n) * 3) % 360, on = i === head, dist = (i - head + n) % n, trail = dist < 6 && dist > 0;
      ctx.beginPath(); p.uv.forEach((q, j) => (j ? ctx.lineTo(q[0] * k, q[1] * k) : ctx.moveTo(q[0] * k, q[1] * k))); ctx.closePath();
      ctx.fillStyle = on ? "#fff" : `hsl(${hue},70%,${trail ? 46 - dist * 3 : 22}%)`; ctx.fill();
      ctx.lineWidth = Math.max(2, 6 * k); ctx.strokeStyle = on ? "#fff" : `hsl(${hue},90%,60%)`; ctx.stroke();
      const xs = p.uv.map((q) => q[0] * k), ys = p.uv.map((q) => q[1] * k), w = Math.max(...xs) - Math.min(...xs);
      if (w > 34) { ctx.fillStyle = on ? "#000" : "#fff"; ctx.font = `${Math.max(9, Math.min(18, w / 7))}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(p.id, (Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2); }
    });
    const sx = ((t * 0.18) % 1) * W; ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(sx, 0, Math.max(2, 4 * k), H);
    ctx.strokeStyle = "#99e836"; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  }
}

/** A video or image file chosen by the user, as the content of a screen. Returns { el, url, kind }. */
export function fileSource(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
    const v = document.createElement("video"); v.src = url; v.loop = true; v.muted = true; v.playsInline = true; v.autoplay = true;
    v.play().catch(() => {}); return { el: v, url, kind: "video", name: file.name };
  }
  const img = new Image(); img.src = url; return { el: img, url, kind: "image", name: file.name };
}

/** WebSocket client for the live bridge. Frames arrive as RGBA; call latest() each frame. */
export class LiveClient {
  constructor(onStatus) {
    this.onStatus = onStatus; this.ws = null; this.frame = null; this.retry = null; this.want = null; this.closed = false;
  }
  url() { return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws"; }
  open() {
    if (this.ws || this.closed) return;
    try { this.ws = new WebSocket(this.url()); } catch (e) { this.onStatus({ type: "error", msg: "WebSocket unavailable here" }); return; }
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => { this.onStatus({ type: "connected" }); if (this.want) this.select(this.want); };
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") { this.onStatus(JSON.parse(ev.data)); return; }
      const dv = new DataView(ev.data), w = dv.getUint32(0, true), h = dv.getUint32(4, true), flags = dv.getUint32(8, true);
      if (ev.data.byteLength === 16 + w * h * 4) this.frame = { rgba: new Uint8Array(ev.data, 16), w, h, alpha: !!(flags & 1) };
    };
    this.ws.onclose = () => { this.ws = null; this.frame = null; this.onStatus({ type: "closed" }); if (!this.closed) this.retry = setTimeout(() => this.open(), 2000); };
    this.ws.onerror = () => {};
  }
  select(name) { this.want = name; this.frame = null; if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ cmd: name ? "select" : "stop", name })); }
  close() { this.closed = true; clearTimeout(this.retry); if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } }
}
