// Run: node tests/math.test.mjs   (no dependencies)
import { lookAtP, project, solveCamera, remapP, cameraCentre } from "../app/js/math.js";
let fails = 0;
const ok = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (s) => (rnd() - 0.5) * 2 * s;

const Ptrue = lookAtP([0.9, -6.6, 1.9], [0, 0.8, 5.4], [0, 0, 1], 55, 1600, 900);
const C = cameraCentre(Ptrue); ok("camera centre recovered from P", Math.hypot(C[0] - 0.9, C[1] + 6.6, C[2] - 1.9) < 1e-6);

// non-coplanar: points scattered through a volume like panels at different heights
const world = Array.from({ length: 14 }, () => [(rnd() - 0.5) * 12, (rnd() - 0.5) * 9, 2.5 + rnd() * 5]);
const img = world.map((X) => { const q = project(Ptrue, X); return [q[0] + noise(0.5), q[1] + noise(0.5)]; });
const r = solveCamera(world, img);
ok("DLT solves (mode: " + r.mode + ")", !r.error && r.rms < 1.0, "rms " + (r.rms || 0).toFixed(3) + " px");
const test = Array.from({ length: 200 }, () => [(rnd() - 0.5) * 12, (rnd() - 0.5) * 9, 2.5 + rnd() * 5]);
const err = test.map((X) => { const a = project(Ptrue, X), b = project(r.P, X); return Math.hypot(a[0] - b[0], a[1] - b[1]); });
ok("DLT camera predicts unseen points", Math.max(...err) < 4, "max error " + Math.max(...err).toFixed(2) + " px");
ok("depth positive in front of the camera", project(r.P, world[0])[2] > 0);

// coplanar: a flat wall (homography path)
const wall = Array.from({ length: 8 }, (_, i) => [(i % 4) * 2 - 3, 0, 1 + Math.floor(i / 4) * 2]);
const wimg = wall.map((X) => { const q = project(Ptrue, X); return [q[0] + noise(0.4), q[1] + noise(0.4)]; });
const rw = solveCamera(wall, wimg);
ok("flat wall uses the homography path", !rw.error && /flat/.test(rw.mode), rw.mode);
const wt = Array.from({ length: 100 }, () => [rnd() * 6 - 3, 0, rnd() * 3 + 0.5]);
const werr = wt.map((X) => { const a = project(Ptrue, X), b = project(rw.P, X); return Math.hypot(a[0] - b[0], a[1] - b[1]); });
ok("flat wall camera predicts unseen points on the wall", Math.max(...werr) < 3, "max error " + Math.max(...werr).toFixed(2) + " px");

// too few points
ok("rejects 3 pairs", !!solveCamera(world.slice(0, 3), img.slice(0, 3)).error);
ok("rejects 5 non-flat pairs", !!solveCamera(world.slice(0, 5), img.slice(0, 5)).error);

// remap (photo fitted into a viewport)
const R = remapP(Ptrue, 0.5, 10, 20), a = project(Ptrue, world[0]), b = project(R, world[0]);
ok("remapP scales and offsets", Math.abs(b[0] - (a[0] * 0.5 + 10)) < 1e-6 && Math.abs(b[1] - (a[1] * 0.5 + 20)) < 1e-6);
console.log(fails ? fails + " FAILED" : "all passed"); process.exit(fails ? 1 : 0);
