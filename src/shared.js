// Constants and helpers shared by the editor (FloorPlanWalker.jsx) and the 3D walk (Walk.jsx).

export const MAX_DIM = 1024;          // downscale source image to this max dimension before vision + editing
export const CEILING_FT_DEFAULT = 8;  // default ceiling height (ft) — she thinks in feet
export const FT_TO_M = 0.3048;
export const IN_TO_M = 0.0254;
export const WALL_T_M = 0.12;          // interior wall thickness (~4.7")
// Residential door/window standards (inches → m). Doors are 36"×80"; openings get an 80" head.
// Windows sit on a ~32" sill with the head aligned to the door head at 80". Default ADD widths use
// a common 32" interior door and 36" window; widths read from a real drawing are kept as-drawn.
export const DOOR_TOP_M = 80 * IN_TO_M;   // door head height (80")
export const WIN_SILL_M = 32 * IN_TO_M;   // window sill height (32")
export const WIN_TOP_M = 80 * IN_TO_M;    // window head height (80", aligned with doors)
export const DOOR_W_M = 32 * IN_TO_M;     // default width when adding a door (32" interior)
export const WIN_W_M = 36 * IN_TO_M;      // default width when adding a window (36" general)
export const EYE_M = 1.6;              // camera eye height (~63")

// Format a length in decimal feet as plain feet-and-inches, e.g. 13.5 -> 13' 6".
// Rounds to the nearest inch and rolls 12" up to the next foot.
export function ftIn(feet) {
  if (!isFinite(feet)) return "—";
  let totalIn = Math.round(feet * 12);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn - ft * 12;
  return inch ? `${ft}' ${inch}"` : `${ft}'`;
}

// How each furniture type is drawn as a simple 3D block: height (m) + color.
export const FURN_3D = {
  bed: { h: 0.55, color: 0x6d7fa6 }, sofa: { h: 0.80, color: 0x5f76a0 }, armchair: { h: 0.85, color: 0x5f76a0 },
  chair: { h: 0.90, color: 0x7c6f5a }, table: { h: 0.75, color: 0x9b7653 }, coffee_table: { h: 0.42, color: 0x9b7653 },
  desk: { h: 0.75, color: 0x9b7653 }, dresser: { h: 0.90, color: 0x9b7653 }, nightstand: { h: 0.50, color: 0x9b7653 },
  wardrobe: { h: 2.00, color: 0x8a6a4a }, bookshelf: { h: 1.80, color: 0x8a6a4a }, tv: { h: 1.10, color: 0x2b2b33 },
  toilet: { h: 0.42, color: 0xeef2f5 }, tub: { h: 0.52, color: 0xeef2f5 }, shower: { h: 2.00, color: 0xcfe6f5 },
  sink: { h: 0.85, color: 0xeef2f5 }, counter: { h: 0.90, color: 0xcfc9bb }, stove: { h: 0.90, color: 0x9aa3ad },
  fridge: { h: 1.80, color: 0x9aa3ad }, rug: { h: 0.02, color: 0x8a5a6a }, other: { h: 0.55, color: 0x8a8597 },
};
export const FURN_TYPE_LIST = Object.keys(FURN_3D);

// geometry for a furniture/stairs box {x,y,w,h,deg} (deg = clockwise, plan space)
export function boxCorners(o) {
  const d = ((o.deg || 0) * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d), hw = o.w / 2, hh = o.h / 2;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ sx, sy, x: o.x + sx * hw * c - sy * hh * s, y: o.y + sx * hw * s + sy * hh * c }));
}
export function boxInside(px, py, o) {
  const d = ((o.deg || 0) * Math.PI) / 180, dx = px - o.x, dy = py - o.y;
  const lx = dx * Math.cos(d) + dy * Math.sin(d), ly = -dx * Math.sin(d) + dy * Math.cos(d);
  return Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2;
}

// ---------- small geometry helpers ----------
export function pointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t, cx, cy };
}

let _id = 1;
export const nid = () => _id++;
