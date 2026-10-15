# previs-lite

A light LED previsualiser you can reuse for any show. Give it your **Resolume pixel map** (an Advanced Output XML), the **positions of the panels**, and **photos of the space**; it shows your content on the panels, in perspective, on top of the photos.

- Content comes from **live Resolume (NDI)**, a **video/image file**, or a built-in **test pattern**.
- Photos are matched to a simple 3D model by clicking the same points in both (a camera solve, no 3D software needed).
- Runs in the browser from one tiny Python script. **No installs** (Python 3 standard library only). No build step.

```
previs.py            the tool: serve, new, check
live.py              optional live NDI bridge (used by `serve --live`)
app/                 the web app (plain JS + WebGL)
projects/<name>/     one folder per venue
tools/modeling.py    helpers for writing a venue model
tests/               camera-solver tests (node tests/math.test.mjs)
CLAUDE.md            how Claude sets up a new venue (read this when asking Claude to build a project)
```

## 1. Start it

```bash
python3 previs.py serve --open            # add --live to receive Resolume over NDI
```

Open the demo project (`demo-wall`, a made-up 12 x 4 LED wall) and try the camera buttons, **Full screen** and **Live NDI**. Regenerate it any time with `python3 tools/make_demo.py`.

## 2. Make a project for a new venue

1. In Resolume, export your **Advanced Output** (the file that contains your screens and slices). Put it somewhere handy.
2. Work out where each slice is in the room. A CSV is enough: `slice_name,x_m,y_m,z_m` (metres; optional `w_m,h_m,nx,ny,nz,ux,uy,uz` for panel size, which way it faces and which way "up" in the image points). See `projects/demo-wall/project.json` for a finished example.
3. Create the project:

```bash
python3 previs.py new my-venue --xml AdvancedOutput.xml --positions panels.csv --screen "LED WALL"
python3 previs.py check my-venue
```

   No positions yet? Leave out `--positions` and each screen is laid out as a flat wall from its own pixel map (`--pixel-pitch-mm` sets the size). Handy for a first look.
4. Add a 3D model of the space. **Drop a `.obj` file on the app** (or press **Import .obj** under 3D model). Its units and up axis are guessed; if it looks wrong, fix **Units**, **Up axis**, **Rotate** and **Place** with the buttons (they are saved with the project). **Lines** shows the sharp edges, **Solid** draws it as a dark solid that hides what is behind it. No model yet? Ask Claude to build one from your photos and measurements (an OBJ, or a plain `model.json` of line segments; `tools/modeling.py` has helpers).
5. Open the app, pick the project and click **+ Add photo of the space** (or drop a photo on the view).

## 3. Match a photo to the model

1. In **Match camera**, the left view is the 3D model, the right view is your photo.
2. Click a point on the model (a panel corner or a model corner), then click **the same point** in the photo. Repeat. Use points spread across the whole photo and at different heights.
3. After 6 pairs (4 if everything is on one flat surface, like a wall) the panels appear on the photo with the **typical error in pixels** at the bottom. Drag a numbered marker in the photo to fine-tune. Wheel zooms the photo, right-drag pans it.
4. **Apply camera** saves it with the project. Add as many photos as you like; each is a camera.

## 4. Use it

| What | How |
|---|---|
| Live from Resolume | `python3 previs.py serve --live`, enable NDI output for the screen in Resolume (Preferences > Video), choose **Live NDI** for that screen. Set `"ndi": "name"` on the screen in `project.json` to connect automatically. |
| Video / image | **Video / image** on a screen. Use a full screen-sized render of your content (the same pixel map Resolume outputs). |
| Look dark / bright | **Panel brightness** and **Photo brightness**. Dimming the photo makes the LEDs read better. |
| Full screen | **Full screen** or **F**. Camera buttons appear at the bottom; **1-9** also switch cameras. |
| Fly around | Pick the **Free fly** camera: **W A S D** move, **Q / E** down and up, **Shift** faster. Look with the mouse: hold the right button and drag, or click the view to capture the pointer (Esc lets go). The wheel changes speed. It starts from where the camera you were just using is. |
| Screenshot | **Screenshot** saves a PNG of the current view. |

Orbit cameras: drag to orbit, shift/right-drag to pan, wheel to zoom.

**Look:** the app uses the SliceFX look (flat, square, one lime accent). Headings and buttons use Neue Machina, labels use Manrope; see `app/fonts/README.md`.

## Notes

- Live NDI needs the NDI runtime, which Resolume already installs. The bridge shrinks frames in pure Python (no numpy). It only listens on your own machine.
- Panels hide the panels behind them and are not drawn from behind (they face one way). Set each panel's `normal` to the direction its face points.
- Everything for a venue lives in `projects/<name>/`, so it is easy to copy, archive or share. Only `demo-wall` is tracked here: `.gitignore` keeps every other project out of the repo so client work is not published by accident. To keep your venues in git, use a private fork and delete the last two lines of `.gitignore`.

More detail: [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md). Setting up with Claude: [CLAUDE.md](CLAUDE.md).
