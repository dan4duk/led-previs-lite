"""Tiny helpers for writing a venue model (projects/NAME/model.json): a list of line segments in metres.
The model is only a wireframe for context and for picking reference points when matching a camera to a photo, so rough is fine:
floor corners, walls, doors, stage edges, truss, scaffold. Coordinates: x east, y north (back of the room), z up.

    from tools.modeling import Model
    m = Model()
    m.box((-10, -8, 0), (10, 12, 6))                 # the room: min corner, max corner
    m.box((-3, 4, 0), (3, 8, 1.0))                   # a stage
    m.grid_floor((-10, -8), (10, 12), step=2)        # floor grid lines (helps judge scale in the photo match)
    m.truss_tower((0, 0), height=8, width=0.5)       # a vertical truss tower
    m.save("projects/my-venue/model.json")
"""
import json, itertools


class Model:
    def __init__(self): self.segs = []

    def line(self, a, b): self.segs.append([*map(float, a), *map(float, b)]); return self

    def polyline(self, pts, closed=False):
        for a, b in zip(pts, pts[1:] + (pts[:1] if closed else [])): self.line(a, b)
        return self

    def box(self, lo, hi):
        xs, ys, zs = zip(lo, hi); c = list(itertools.product(xs, ys, zs))
        for a, b in itertools.combinations(c, 2):
            if sum(1 for i in range(3) if a[i] != b[i]) == 1: self.line(a, b)
        return self

    def grid_floor(self, lo, hi, step=1.0, z=0.0):
        x = lo[0]
        while x <= hi[0] + 1e-9: self.line((x, lo[1], z), (x, hi[1], z)); x += step
        y = lo[1]
        while y <= hi[1] + 1e-9: self.line((lo[0], y, z), (hi[0], y, z)); y += step
        return self

    def truss_tower(self, xy, height, width=0.4, bays=None):
        x, y = xy; h = width / 2; bays = bays or max(1, round(height / width))
        corners = [(x - h, y - h), (x + h, y - h), (x + h, y + h), (x - h, y + h)]
        for cx, cy in corners: self.line((cx, cy, 0), (cx, cy, height))
        for k in range(bays + 1):
            z = height * k / bays; self.polyline([(cx, cy, z) for cx, cy in corners], closed=True)
        return self

    def circle(self, centre, radius, z=0.0, n=24):
        import math
        pts = [(centre[0] + radius * math.cos(2 * math.pi * i / n), centre[1] + radius * math.sin(2 * math.pi * i / n), z) for i in range(n)]
        return self.polyline(pts, closed=True)

    def save(self, path):
        json.dump([[round(v, 3) for v in s] for s in self.segs], open(path, "w"), separators=(",", ":")); print("wrote", path, len(self.segs), "segments")
