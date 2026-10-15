// Run: node tests/obj.test.mjs
import { parseOBJ, featureEdges, transformModel, guessUnits, guessUp, extents } from "../app/js/obj.js";
let fails = 0; const ok = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!c) fails++; };
// a 2 x 3 x 5 box built from quads (like most exporters), Z-up, plus a comment line and texture/normal indices
const v = [[0,0,0],[2,0,0],[2,3,0],[0,3,0],[0,0,5],[2,0,5],[2,3,5],[0,3,5]];
const quads = [[1,4,3,2],[5,6,7,8],[1,2,6,5],[2,3,7,6],[3,4,8,7],[4,1,5,8]];
const box = "# box\n" + v.map(p => "v " + p.join(" ")).join("\n") + "\nvt 0 0\nvn 0 0 1\n" + quads.map(q => "f " + q.map(i => i + "/1/1").join(" ")).join("\n") + "\n";
const m = parseOBJ(box);
ok("parses 8 vertices", m.pos.length === 24); ok("quads become 12 triangles", m.tris.length === 36);
const edges = featureEdges(m); ok("box has 12 sharp edges (the quad diagonals are dropped)", edges.length / 2 === 12, "got " + edges.length / 2);
const e = extents(m.pos); ok("size 2 x 3 x 5", e.size.join() === "2,3,5");
// units and up axis
ok("guess: 2..5 units is metres", guessUnits(m.pos) === "m"); ok("guess: 5 high (z) vs 3 deep (y) -> y is the shorter, so Y-up", guessUp(m.pos) === "y");
const mm = parseOBJ(box.replace(/^v (.*)$/gm, (_, s) => "v " + s.split(" ").map(x => x * 1000).join(" ")));
ok("guess: thousands means millimetres", guessUnits(mm.pos) === "mm");
const cm = parseOBJ(box.replace(/^v (.*)$/gm, (_, s) => "v " + s.split(" ").map(x => x * 300).join(" ")));   // 6 x 9 x 15 m written in cm
ok("guess: a 15 m model written as 1500 is centimetres", guessUnits(cm.pos) === "cm");
const t1 = transformModel(mm, featureEdges(mm), { units: "mm", up: "z", rot: 0, place: "asis" });
ok("mm -> metres", Math.abs(t1.size[0] - 2) < 1e-6 && Math.abs(t1.size[2] - 5) < 1e-6, t1.size.map(v => +v.toFixed(3)).join(" x "));
const t2 = transformModel(m, edges, { units: "m", up: "y", rot: 0, place: "asis" });
ok("Y-up becomes Z-up (height 3 now on z)", Math.abs(t2.size[2] - 3) < 1e-9 && Math.abs(t2.size[1] - 5) < 1e-9, t2.size.join(" x "));
const t3 = transformModel(m, edges, { units: "m", up: "z", rot: 90, place: "centre" });
ok("rotate 90 swaps x and y", Math.abs(t3.size[0] - 3) < 1e-9 && Math.abs(t3.size[1] - 2) < 1e-9);
ok("centre + floor", Math.abs(t3.lo[2]) < 1e-9 && Math.abs(t3.lo[0] + t3.hi[0]) < 1e-9 && Math.abs(t3.lo[1] + t3.hi[1]) < 1e-9);
ok("mesh has 12 triangles x 3 vertices x 6 floats", t3.mesh.length === 12 * 18); ok("segments 12 x 6 floats", t3.segments.length === 12 * 6);
// robustness: negative indices, line elements, junk
const neg = parseOBJ("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nl 1 2\nf 1 2 99\nusemtl x\ng a\n");
ok("negative indices work, bad faces are dropped", neg.tris.length === 3 && neg.lines.length === 2);
ok("a lone triangle: 3 boundary edges + 1 line element", featureEdges(neg).length / 2 === 4);
console.log(fails ? fails + " FAILED" : "all passed"); process.exit(fails ? 1 : 0);
