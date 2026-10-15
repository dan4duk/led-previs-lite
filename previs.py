#!/usr/bin/env python3
"""previs-lite: a light LED previsualiser.

  python3 previs.py serve [--live] [--port 8765]     start the app (and the Resolume NDI bridge with --live)
  python3 previs.py new NAME --xml AdvancedOutput.xml [--positions panels.csv] [--screen NAME]...
                                                       create projects/NAME from a Resolume Advanced Output XML
  python3 previs.py check NAME                         check a project and say what is missing

Standard library only. See README.md for the project format and CLAUDE.md for the set-up playbook."""
import argparse, base64, csv, hashlib, json, os, re, shutil, socket, struct, sys, threading, time, webbrowser
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
APP, PROJECTS = os.path.join(ROOT, "app"), os.path.join(ROOT, "projects")
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
         ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4",
         ".mov": "video/quicktime", ".webm": "video/webm", ".csv": "text/csv", ".xml": "text/xml", ".txt": "text/plain", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2"}


# ---------------------------------------------------------------- Resolume Advanced Output XML -> screens
def read_advanced_output(path):
    """Returns [{name, size:[w,h], slices:[{name, quad:[[x,y]x4]}]}]. The quad is the slice's OutputRect: where it sits on the screen's pixel map."""
    root = ET.parse(path).getroot()
    out = []
    for sc in root.iter("Screen"):
        slices = []
        for sl in sc.iter("Slice"):
            name = next((p.get("value") for p in sl.iter("Param") if p.get("name") == "Name"), None) or "slice%d" % (len(slices) + 1)
            rect = sl.find(".//OutputRect")
            vs = [(float(v.get("x")), float(v.get("y"))) for v in rect.findall("v")] if rect is not None else []
            if len(vs) == 4: slices.append({"name": name, "quad": [list(v) for v in vs]})
        size = None
        for dev in sc.iter():
            if dev.tag.startswith("OutputDevice") and dev.get("width") and dev.get("height"):
                size = [int(dev.get("width")), int(dev.get("height"))]; break
        if size is None and slices:
            xs = [p[0] for s in slices for p in s["quad"]]; ys = [p[1] for s in slices for p in s["quad"]]
            size = [int(max(xs)), int(max(ys))]
        if slices: out.append({"name": sc.get("name") or "Screen", "size": size, "slices": slices})
    return out


def read_positions(path):
    """CSV with a header. Needed: slice_name, x_m, y_m, z_m. Optional: w_m, h_m (panel size), nx, ny, nz (face direction), ux, uy, uz (image up)."""
    rows = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            r = {k.strip().lower(): (v or "").strip() for k, v in r.items() if k}
            name = r.get("slice_name") or r.get("name") or r.get("id")
            if not name: continue
            g = lambda *ks: next((float(r[k]) for k in ks if r.get(k, "") != ""), None)
            pos = [g("x_m", "x"), g("y_m", "y"), g("z_m", "z")]
            if None in pos: continue
            e = {"pos": pos}
            if g("w_m", "w") is not None and g("h_m", "h") is not None: e["size"] = [g("w_m", "w"), g("h_m", "h")]
            if None not in [g("nx"), g("ny"), g("nz")]: e["normal"] = [g("nx"), g("ny"), g("nz")]
            if None not in [g("ux"), g("uy"), g("uz")]: e["up"] = [g("ux"), g("uy"), g("uz")]
            rows[name] = e
    return rows


FACING = {"down": ([0, 0, -1], [0, 1, 0]), "up": ([0, 0, 1], [0, 1, 0]), "front": ([0, -1, 0], [0, 0, 1]), "back": ([0, 1, 0], [0, 0, 1]),
          "east": ([1, 0, 0], [0, 0, 1]), "west": ([-1, 0, 0], [0, 0, 1])}


def cmd_new(a):
    pdir = os.path.join(PROJECTS, a.name)
    if os.path.exists(os.path.join(pdir, "project.json")) and not a.force: sys.exit("projects/%s already exists (use --force to overwrite)." % a.name)
    for f in [a.xml] + ([a.positions] if a.positions else []):
        if not os.path.isfile(f): sys.exit("File not found: %s" % f)
    try: screens = read_advanced_output(a.xml)
    except ET.ParseError as e: sys.exit("That file is not valid XML (%s). Export it from Resolume: Advanced Output > Save / Screen Setup." % e)
    if not screens: sys.exit("No screens with slices found in that XML. Is it a Resolume Advanced Output / Screen Setup export?")
    if a.screen:
        screens = [s for s in screens if s["name"] in a.screen]
        if not screens: sys.exit("None of those screens are in the XML. Available: " + ", ".join(s["name"] for s in read_advanced_output(a.xml)))
    pos = read_positions(a.positions) if a.positions else {}
    normal, up = FACING[a.facing]
    mm = a.pixel_pitch_mm / 1000.0
    out, missing = [], []
    for s in screens:
        panels, used = [], set()
        for sl in s["slices"]:
            nm, k = sl["name"], 2
            while nm in used: nm = "%s_%d" % (sl["name"], k); k += 1
            used.add(nm); xs = [p[0] for p in sl["quad"]]; ys = [p[1] for p in sl["quad"]]
            p = {"id": nm, "uv": sl["quad"]}
            if sl["name"] in pos: p.update({"size": [(max(xs) - min(xs)) * mm, (max(ys) - min(ys)) * mm], "normal": normal, "up": up}); p.update(pos[sl["name"]])
            elif not a.positions:   # no positions at all: lay the screen out flat from its own pixel map (a flat LED wall)
                p.update({"pos": [(sum(xs) / 4 - s["size"][0] / 2) * mm, 0, (s["size"][1] / 2 - sum(ys) / 4) * mm], "size": [(max(xs) - min(xs)) * mm, (max(ys) - min(ys)) * mm], "normal": normal if a.facing != "down" else FACING["front"][0], "up": up if a.facing != "down" else FACING["front"][1]})
            else: missing.append(nm); continue
            p.setdefault("size", [0.5, 0.5]); panels.append(p)
        out.append({"id": re.sub(r"\W+", "_", s["name"]).strip("_").lower() or "screen", "name": s["name"], "size": s["size"], "ndi": "", "panels": panels})
    os.makedirs(os.path.join(pdir, "photos"), exist_ok=True); os.makedirs(os.path.join(pdir, "sources"), exist_ok=True)
    for f in [a.xml] + ([a.positions] if a.positions else []):   # keep the inputs with the project (skip if they are already there)
        dst = os.path.join(pdir, "sources", os.path.basename(f))
        if os.path.realpath(f) != os.path.realpath(dst): shutil.copy(f, dst)
    proj = {"version": 1, "name": a.title or a.name, "units": "m", "screens": out, "model": None,
            "cameras": [{"name": "Orbit", "type": "orbit", "target": [0, 0, 2], "distance": 18, "yaw": 35, "pitch": 18, "fov": 45}]}
    json.dump(proj, open(os.path.join(pdir, "project.json"), "w"), indent=1)
    print("created projects/%s: %d screen(s), %d panel(s)" % (a.name, len(out), sum(len(s["panels"]) for s in out)))
    if missing: print("WARNING: %d slice(s) have no 3D position and were left out, e.g. %s" % (len(missing), ", ".join(missing[:5])))
    if a.positions is None: print("No positions CSV given: each screen was laid out as a flat wall from its pixel map at %.1f mm pitch. Edit project.json or pass --positions." % a.pixel_pitch_mm)
    print("Next: python3 previs.py serve   then open the project and add photos (see README.md).")


def cmd_check(a):
    pdir = os.path.join(PROJECTS, a.name); pj = os.path.join(pdir, "project.json")
    if not os.path.exists(pj): sys.exit("projects/%s/project.json not found." % a.name)
    p = json.load(open(pj)); problems = []
    print("project:", p.get("name"))
    for s in p.get("screens", []):
        W, H = s["size"]; ids = [q["id"] for q in s["panels"]]
        print("  screen %-24s %dx%d  %d panels  ndi source filter: %r" % (s["name"], W, H, len(s["panels"]), s.get("ndi", "")))
        if len(set(ids)) != len(ids): problems.append("screen %s has duplicate panel ids" % s["name"])
        for q in s["panels"]:
            if not q.get("pos") or len(q["pos"]) != 3: problems.append("panel %s has no pos [x,y,z]" % q["id"])
            if len(q.get("uv", [])) != 4: problems.append("panel %s needs uv: four [x,y] corners on the screen pixel map" % q["id"])
            else:
                for x, y in q["uv"]:
                    if x < -1 or y < -1 or x > W + 1 or y > H + 1: problems.append("panel %s uv outside the %dx%d screen" % (q["id"], W, H)); break
    m = p.get("model")
    mfile = m.get("file") if isinstance(m, dict) else m
    if mfile:
        mp = os.path.join(pdir, mfile)
        if not os.path.exists(mp): problems.append("model file %s missing" % mfile)
        elif mfile.lower().endswith(".obj"):
            n = sum(1 for ln in open(mp, errors="ignore") if ln.startswith("f ")); print("  model: %s (OBJ, %d faces; units/up-axis/placement are set in the app)" % (mfile, n))
        else:
            segs = json.load(open(mp)); print("  model: %d line segments" % len(segs))
    else: print("  model: none (drop a .obj onto the app, or add model.json: [[x1,y1,z1,x2,y2,z2], ...] in metres)")
    for c in p.get("cameras", []):
        if c.get("type") == "photo":
            ok = os.path.exists(os.path.join(pdir, c.get("photo", "")))
            print("  camera %-20s photo %s  %s" % (c["name"], c.get("photo"), "matched" if c.get("P") else "NOT matched yet"))
            if not ok: problems.append("camera %s: photo file missing" % c["name"])
    print("OK, no problems found." if not problems else "PROBLEMS:\n  - " + "\n  - ".join(problems))
    return 1 if problems else 0


# ---------------------------------------------------------------- server
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
NDI = None   # set by --live


def ws_frame(op, payload):
    n = len(payload)
    return bytes([0x80 | op]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536 else b"\x7f" + struct.pack(">Q", n)) + payload


def recv_exact(sock, n):
    b = b""
    while len(b) < n:
        c = sock.recv(n - len(b))
        if not c: raise ConnectionError
        b += c
    return b


def safe_join(base, rel):
    p = os.path.realpath(os.path.join(base, rel.lstrip("/")))
    return p if p == os.path.realpath(base) or p.startswith(os.path.realpath(base) + os.sep) else None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def send_bytes(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path); path = unquote(u.path)
        if path == "/ws" and "websocket" in self.headers.get("Upgrade", "").lower(): return self.ws()
        if path == "/api/projects":
            names = sorted(d for d in os.listdir(PROJECTS) if os.path.exists(os.path.join(PROJECTS, d, "project.json"))) if os.path.isdir(PROJECTS) else []
            return self.send_bytes(200, json.dumps({"projects": names, "live": NDI is not None}).encode())
        base, rel = (PROJECTS, path[len("/projects/"):]) if path.startswith("/projects/") else (APP, "index.html" if path == "/" else path)
        f = safe_join(base, rel)
        if not f or not os.path.isfile(f): return self.send_bytes(404, b'{"error":"not found"}')
        self.send_bytes(200, open(f, "rb").read(), TYPES.get(os.path.splitext(f)[1].lower(), "application/octet-stream"))

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query); n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n)
        name = (q.get("project") or [""])[0]
        if not re.fullmatch(r"[\w\-. ]+", name) or not os.path.isdir(os.path.join(PROJECTS, name)): return self.send_bytes(400, b'{"error":"unknown project"}')
        pdir = os.path.join(PROJECTS, name)
        if u.path == "/api/save":                           # the app saves project.json (the previous one is kept as project.json.bak)
            try: json.loads(body)
            except ValueError: return self.send_bytes(400, b'{"error":"bad json"}')
            pj = os.path.join(pdir, "project.json")
            if os.path.exists(pj): shutil.copy(pj, pj + ".bak")
            open(pj, "wb").write(body); return self.send_bytes(200, b'{"ok":true}')
        if u.path == "/api/upload":                         # a dropped photo (photos/) or 3D model (models/)
            fn = re.sub(r"[^\w\-. ]", "_", os.path.basename((q.get("name") or ["photo.jpg"])[0]))
            ext = os.path.splitext(fn)[1].lower(); sub = "photos" if ext in (".jpg", ".jpeg", ".png", ".webp") else "models" if ext == ".obj" else None
            if not sub: return self.send_bytes(400, b'{"error":"photos (jpg, png, webp) or models (.obj) only"}')
            os.makedirs(os.path.join(pdir, sub), exist_ok=True); open(os.path.join(pdir, sub, fn), "wb").write(body)
            return self.send_bytes(200, json.dumps({"path": sub + "/" + fn}).encode())
        self.send_bytes(404, b'{"error":"not found"}')

    def ws(self):
        from live import Receiver
        key = self.headers["Sec-WebSocket-Key"]
        self.send_response(101); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()); self.end_headers(); self.wfile.flush()
        sock, lock, alive, rx = self.connection, threading.Lock(), [True], [None]
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        def send(op, payload):
            with lock: sock.sendall(ws_frame(op, payload))

        def select(name):
            if rx[0]: rx[0].stop_flag = True; rx[0] = None
            if name and NDI: rx[0] = Receiver(NDI, name); rx[0].start()

        def reader():
            try:
                while alive[0]:
                    b1, b2 = recv_exact(sock, 2); op, ln = b1 & 15, b2 & 127
                    ln = struct.unpack(">H", recv_exact(sock, 2))[0] if ln == 126 else struct.unpack(">Q", recv_exact(sock, 8))[0] if ln == 127 else ln
                    mask = recv_exact(sock, 4) if b2 & 128 else b"\0\0\0\0"
                    p = bytes(x ^ mask[i % 4] for i, x in enumerate(recv_exact(sock, ln))) if ln else b""
                    if op == 8: break
                    if op == 9: send(10, p)
                    if op == 1:
                        m = json.loads(p.decode())
                        if m.get("cmd") == "select": select(m.get("name"))
                        elif m.get("cmd") == "stop": select(None)
            except Exception: pass
            alive[0] = False

        threading.Thread(target=reader, daemon=True).start()
        last_seq, last_status, last_send = -1, 0, 0
        try:
            while alive[0]:
                r = rx[0]
                if r:
                    with r.cond: r.cond.wait(timeout=0.2)
                    if r.seq != last_seq and r.frame and time.time() - last_send >= 1 / 30.0:
                        last_seq, last_send = r.seq, time.time(); send(2, r.frame)
                else: time.sleep(0.1); last_seq = -1
                if time.time() - last_status > 1.0:
                    last_status = time.time()
                    send(1, json.dumps({"type": "status", "sources": NDI.names() if NDI else [], "current": r.name if r else None, "fps": round(r.fps, 1) if r else 0, "info": r.info if r else ""}).encode())
        except Exception: pass
        alive[0] = False
        if rx[0]: rx[0].stop_flag = True
        self.close_connection = True


def cmd_serve(a):
    global NDI
    if a.live:
        try:
            from live import Ndi
            NDI = Ndi(); print("NDI runtime:", NDI.path)
        except Exception as e:
            print("Live NDI is off:", e)
    os.makedirs(PROJECTS, exist_ok=True)
    srv = ThreadingHTTPServer((a.host, a.port), Handler); srv.daemon_threads = True
    url = "http://%s:%d/" % ("127.0.0.1" if a.host in ("0.0.0.0", "") else a.host, a.port)
    print("previs-lite running at", url, "(Ctrl+C to stop)", "[live NDI on]" if NDI else "[live NDI off: run with --live]", flush=True)
    if a.open: threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try: srv.serve_forever()
    except KeyboardInterrupt: pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0]); sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="start the app"); s.add_argument("--port", type=int, default=8765); s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--live", action="store_true", help="enable the Resolume NDI bridge"); s.add_argument("--open", action="store_true", help="open the browser")
    n = sub.add_parser("new", help="create a project from a Resolume Advanced Output XML"); n.add_argument("name"); n.add_argument("--xml", required=True)
    n.add_argument("--positions", help="CSV: slice_name,x_m,y_m,z_m[,w_m,h_m,nx,ny,nz,ux,uy,uz]"); n.add_argument("--screen", action="append", help="only these screens (repeatable)")
    n.add_argument("--title"); n.add_argument("--facing", choices=sorted(FACING), default="front", help="default direction the panels face (default front)")
    n.add_argument("--pixel-pitch-mm", type=float, default=3.9, dest="pixel_pitch_mm", help="mm per pixel, used for panel size and the flat-wall layout"); n.add_argument("--force", action="store_true")
    c = sub.add_parser("check", help="check a project"); c.add_argument("name")
    a = ap.parse_args()
    if a.cmd == "new": cmd_new(a)
    elif a.cmd == "check": sys.exit(cmd_check(a))
    else: cmd_serve(a if a.cmd == "serve" else ap.parse_args(["serve"] + sys.argv[1:]))


if __name__ == "__main__":
    main()
