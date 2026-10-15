"""Writes projects/demo-wall: a made-up 12 x 4 LED wall in a plain room, so there is something to open on a fresh clone.
Run from the repo root:  python3 tools/make_demo.py
It shows the shape of a project (screens, panels, model, cameras) without needing a Resolume file."""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools.modeling import Model

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "projects", "demo-wall")
COLS, ROWS, TILE_PX, TILE_M = 12, 4, 160, 0.5          # 160 px panels, 0.5 m each
W, H = COLS * TILE_PX, ROWS * TILE_PX                  # 1920 x 640 pixel map
WALL_Y, BOTTOM_Z = 6.0, 0.9                            # the wall is on the north side, bottom edge 0.9 m up, facing the room (south)

panels = []
for r in range(ROWS):
    for c in range(COLS):
        x0, y0 = c * TILE_PX, r * TILE_PX
        panels.append({"id": "W%02d_R%d" % (c + 1, r + 1), "uv": [[x0, y0], [x0 + TILE_PX, y0], [x0 + TILE_PX, y0 + TILE_PX], [x0, y0 + TILE_PX]],
                       "pos": [round((c - (COLS - 1) / 2) * TILE_M, 3), WALL_Y, round(BOTTOM_Z + (ROWS - 1 - r + 0.5) * TILE_M, 3)],
                       "size": [TILE_M, TILE_M], "normal": [0, -1, 0], "up": [0, 0, 1]})

os.makedirs(os.path.join(ROOT, "photos"), exist_ok=True)
m = Model()
m.box((-8, -6, 0), (8, 6, 5))                           # the room
m.box((-4, 3.4, 0), (4, 6, 0.9))                        # a stage in front of the wall
m.box((-3.2, 5.9, 0.9), (3.2, 6.0, 2.9))                # the wall frame
m.grid_floor((-8, -6), (8, 6), step=2)
m.truss_tower((-3.7, 5.6), height=3.4, width=0.3); m.truss_tower((3.7, 5.6), height=3.4, width=0.3)
m.box((-1, -5.8, 0), (1, -5.4, 1.1))                    # a mixing desk at the back of the room
m.save(os.path.join(ROOT, "model.json"))

project = {"version": 1, "name": "Demo LED wall", "units": "m", "model": "model.json",
           "screens": [{"id": "wall", "name": "WALL", "size": [W, H], "ndi": "", "panels": panels}],
           "cameras": [{"name": "Front", "type": "orbit", "target": [0, 6, 2], "distance": 13, "yaw": 0, "pitch": 6, "fov": 45},
                       {"name": "From the side", "type": "orbit", "target": [0, 5, 2], "distance": 12, "yaw": 62, "pitch": 8, "fov": 45}]}
json.dump(project, open(os.path.join(ROOT, "project.json"), "w"), indent=1)
print("wrote projects/demo-wall:", len(panels), "panels, %dx%d pixel map" % (W, H))
