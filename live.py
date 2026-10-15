"""Live NDI -> browser bridge for previs-lite. Standard library only (ctypes talks to the NDI runtime).

A browser cannot receive NDI, so previs.py (with --live) uses this to receive a Resolume NDI output and push frames to the page over
a WebSocket. Each browser connection gets its own receiver, so two screens (e.g. LED and stage) can be live at once.
Frames are shrunk by taking every k-th pixel (nearest neighbour) so no numpy is needed; k is chosen so the width is <= 1536 px.
Wire format of a binary message: 16-byte header <IIII (width, height, flags, sequence) then width*height*4 bytes RGBA.
flags bit 0 = the stream carries alpha. Text messages are JSON: server -> client {"type":"status",...}; client -> server {"cmd":"select","name":...}."""
import ctypes, glob, os, struct, threading, time

LIBS = ["/Applications/Resolume Arena/libndi.dylib", "/Applications/Resolume Alley/libndi.dylib", "/Applications/Resolume Wire/libndi.dylib",
        "/usr/local/lib/libndi.dylib", "/opt/homebrew/lib/libndi.dylib", "/Library/NDI SDK for Apple/lib/macOS/libndi.dylib",
        r"C:\Program Files\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll", r"C:\Program Files\NDI\NDI 5 Runtime\Processing.NDI.Lib.x64.dll",
        "/usr/lib/libndi.so.6", "/usr/local/lib/libndi.so.6"] + glob.glob("/Applications/NDI*/**/libndi*.dylib", recursive=True)
FOURCC_RGBX = 0x58424752


class Src(ctypes.Structure): _fields_ = [("name", ctypes.c_char_p), ("url", ctypes.c_char_p)]
class FindCfg(ctypes.Structure): _fields_ = [("show_local", ctypes.c_bool), ("groups", ctypes.c_char_p), ("extra", ctypes.c_char_p)]
class RecvCfg(ctypes.Structure): _fields_ = [("src", Src), ("color", ctypes.c_int), ("bw", ctypes.c_int), ("fields", ctypes.c_bool), ("name", ctypes.c_char_p)]
class Video(ctypes.Structure):
    _fields_ = [("xres", ctypes.c_int), ("yres", ctypes.c_int), ("fourcc", ctypes.c_int), ("frN", ctypes.c_int), ("frD", ctypes.c_int),
                ("ar", ctypes.c_float), ("fmt", ctypes.c_int), ("tc", ctypes.c_int64), ("data", ctypes.c_void_p), ("stride", ctypes.c_int),
                ("meta", ctypes.c_char_p), ("ts", ctypes.c_int64)]


class Ndi:
    """The NDI runtime plus a background source finder."""
    def __init__(self):
        self.lib = None
        for p in LIBS:
            if os.path.exists(p):
                try:
                    d = ctypes.CDLL(p); d.NDIlib_initialize.restype = ctypes.c_bool
                    if d.NDIlib_initialize(): self.lib, self.path = d, p; break
                except OSError:
                    pass
        if not self.lib:
            raise RuntimeError("NDI runtime not found. Install NDI Tools (or Resolume, which ships it) and try again.")
        n = self.lib
        n.NDIlib_find_create_v2.restype = ctypes.c_void_p; n.NDIlib_find_create_v2.argtypes = [ctypes.POINTER(FindCfg)]
        n.NDIlib_find_get_current_sources.restype = ctypes.POINTER(Src); n.NDIlib_find_get_current_sources.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        n.NDIlib_recv_create_v3.restype = ctypes.c_void_p; n.NDIlib_recv_create_v3.argtypes = [ctypes.POINTER(RecvCfg)]
        n.NDIlib_recv_destroy.argtypes = [ctypes.c_void_p]
        n.NDIlib_recv_capture_v2.restype = ctypes.c_int
        n.NDIlib_recv_capture_v2.argtypes = [ctypes.c_void_p, ctypes.POINTER(Video), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
        n.NDIlib_recv_free_video_v2.argtypes = [ctypes.c_void_p, ctypes.POINTER(Video)]
        self.find = n.NDIlib_find_create_v2(ctypes.byref(FindCfg(True, None, None)))
        self.sources = []
        threading.Thread(target=self._refresh, daemon=True).start()

    def _refresh(self):
        while True:
            cnt = ctypes.c_uint32(0)
            arr = self.lib.NDIlib_find_get_current_sources(self.find, ctypes.byref(cnt))
            self.sources = [(arr[i].name, arr[i].url) for i in range(cnt.value)]
            time.sleep(1.0)

    def names(self):
        return [s[0].decode() for s in self.sources]


class Receiver(threading.Thread):
    """Receives one NDI source and keeps the latest shrunk RGBA frame."""
    def __init__(self, ndi, name):
        super().__init__(daemon=True)
        self.ndi, self.name, self.stop_flag = ndi, name, False
        self.cond, self.seq, self.frame, self.fps, self.info = threading.Condition(), 0, None, 0.0, ""

    @staticmethod
    def shrink(v):
        k = 1
        while v.xres // k > 1536: k += 1
        sp = v.stride // 4
        mv = memoryview((ctypes.c_uint32 * (sp * v.yres)).from_address(v.data))
        rows = [mv[r * sp: r * sp + v.xres: k].tobytes() for r in range(0, v.yres, k)]
        return len(range(0, v.xres, k)), len(rows), b"".join(rows)

    def run(self):
        n = self.ndi.lib
        src = next(((a, b) for a, b in self.ndi.sources if a.decode() == self.name), None)
        if not src: return
        recv = n.NDIlib_recv_create_v3(ctypes.byref(RecvCfg(Src(*src), 2, 100, False, b"previs-lite")))   # RGBX/RGBA out, highest bandwidth
        vid, frames, t0 = Video(), 0, time.time()
        try:
            while not self.stop_flag:
                if n.NDIlib_recv_capture_v2(recv, ctypes.byref(vid), None, None, 200) != 1: continue
                w, h, data = self.shrink(vid)
                alpha = vid.fourcc != FOURCC_RGBX
                self.info = "%dx%d%s" % (vid.xres, vid.yres, " alpha" if alpha else "")
                n.NDIlib_recv_free_video_v2(recv, ctypes.byref(vid))
                frames += 1
                if time.time() - t0 >= 2: self.fps, frames, t0 = frames / (time.time() - t0), 0, time.time()
                with self.cond:
                    self.seq += 1; self.frame = struct.pack("<IIII", w, h, 1 if alpha else 0, self.seq) + data; self.cond.notify_all()
        finally:
            n.NDIlib_recv_destroy(recv)
