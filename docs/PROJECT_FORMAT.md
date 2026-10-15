# Project format

A project is a folder `projects/<name>/`:

```
project.json        screens, panels, cameras (written by `previs.py new`, edited by the app and by hand)
model.json          optional: wireframe of the space, [[x1,y1,z1,x2,y2,z2], ...] in metres
models/             an imported .obj (drop it on the app; project.json points to it)
photos/             photos of the space (the app saves dropped photos here)
sources/            the Resolume XML and positions CSV the project was made from (for reference)
```

## Coordinates

Metres, right-handed, **x east, y north (the back of the room), z up**. Pick any origin you like (the centre of the stage or rig is a good one) and keep the model and the panels in the same frame.

Each panel has a **normal** (the direction its face points, towards the audience) and an **up** (the direction the top edge of its image points). The image runs left to right as seen from in front of the face, which is `cross(-normal, up)`. Typical: a wall facing the room from the north side has normal `[0,-1,0]`, up `[0,0,1]`; a panel hanging face down has normal `[0,0,-1]` and up `[0,1,0]`.

## project.json

```json
{
  "version": 1,
  "name": "Demo LED wall",
  "units": "m",
  "model": "model.json",
  "screens": [
    {
      "id": "wall",
      "name": "WALL",
      "size": [1920, 640],
      "ndi": "WALL",
      "panels": [
        { "id": "W01_R1",
          "uv": [[0,0],[160,0],[160,160],[0,160]],
          "pos": [-2.75, 6.0, 2.65],
          "size": [0.5, 0.5],
          "normal": [0, -1, 0],
          "up": [0, 0, 1] }
      ]
    }
  ],
  "cameras": [
    { "name": "Front", "type": "orbit", "target": [0,6,2], "distance": 13, "yaw": 0, "pitch": 6, "fov": 45 },
    { "name": "Deck photo", "type": "photo", "photo": "photos/deck.jpg", "size": [4032, 3024],
      "P": [12 numbers], "rms": 1.2, "pairs": [ { "world": [x,y,z], "image": [u,v] } ] }
  ]
}
```

- **screen.size** is the output's pixel size: the size of the NDI frame, or of the video you load.
- **panel.uv** is where the panel sits on the screen's pixel map: four `[x, y]` corners in pixels (top-left origin) in the order top-left, top-right, bottom-right, bottom-left **of the panel as it should read**. `previs.py new` takes this from the slice's *OutputRect* in the Resolume XML.
- **panel.pos** is the centre of the panel in metres; **size** is `[width, height]` in metres.
- **screen.ndi** (optional) is a text filter: the live source whose name contains it is connected automatically.
- **Orbit cameras**: `target`, `distance` (m), `yaw` (degrees, 0 = looking from the front/south towards +y), `pitch` (degrees, negative looks up from below), `fov` (vertical degrees).
- **Fly cameras**: `{ "type": "fly", "pos": [x, y, z], "yaw": radians (0 = looking north, +y), "pitch": radians, "fov": degrees }`. Every project gets one called "Free fly"; flying moves it, and Save keeps where it was left.
- **Photo cameras**: `P` is the solved 3x4 projection matrix, row-major, in the photo's own pixel space (written by **Apply camera**). `pairs` are the clicked point pairs, kept so you can re-match later.

## panels.csv (input to `previs.py new`)

Header row required. Columns (case-insensitive):

| column | meaning |
|---|---|
| `slice_name` | must equal the slice *Name* in the Resolume XML |
| `x_m`, `y_m`, `z_m` | panel centre, metres |
| `w_m`, `h_m` | optional panel size in metres (default: slice pixels x pixel pitch) |
| `nx`, `ny`, `nz` | optional face direction (default from `--facing`) |
| `ux`, `uy`, `uz` | optional image-up direction (default from `--facing`) |

`--facing` is one of `front, back, east, west, up, down` and sets the default normal and up for every panel.

## Model: an imported .obj

Drop a Wavefront `.obj` on the app. It is copied to `models/` and `project.json` gets:

```json
"model": { "file": "models/venue.obj", "format": "obj", "units": "cm", "up": "y", "rot": 0, "place": "asis", "display": "lines" }
```

- `units`: `m`, `cm`, `mm`, `ft` or `in`, the unit the file was written in (guessed from its size).
- `up`: `z` or `y`, the up axis of the file (guessed: the shorter of Y and Z is usually the height). Y-up files (Blender's default export) are turned into the project's Z-up.
- `rot`: 0, 90, 180 or 270 degrees about Z.
- `place`: `asis` (keep the file's own coordinates, best when the model was built in the project's frame), `floor` (lowest point at z = 0) or `centre` (centred on x and y, floor at z = 0).
- `display`: `lines` (the sharp edges only) or `solid` (also a dark two-sided solid).

Only faces and `l` line elements are read; materials, textures and normals are ignored. Sharp edges are boundary edges and edges where neighbouring faces differ by more than 28 degrees, so a quad's diagonal does not show.

## model.json

A flat list of line segments `[x1, y1, z1, x2, y2, z2]` in metres. `tools/modeling.py` writes one from boxes, grids, truss towers and circles. The camera matcher lets you click on the endpoints of these lines, so include the things that are clearly visible in your photos: floor and wall corners, doors, stage edges, truss, pillars.

## The camera solver

Clicked pairs are solved by a direct linear transform (DLT) into a 3x4 projection matrix. It needs 6 or more pairs that are not all on one plane. If all pairs are on one flat surface (for example a wall), it switches to a plane homography and needs 4. The result reports the typical and worst reprojection error in pixels; under 3 px is a good match. The maths and its tests are in `app/js/math.js` and `tests/math.test.mjs`.
