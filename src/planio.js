// src/planio.js
//
// Everything that brings a plan IN (Claude's reply, a saved plan, a plan file, a share link)
// passes through a cleaner here, so bad numbers or huge lists can never reach the editor or
// the 3D walk. Also: plan files, share links and the 2D plan picture.

import { nid, FURN_TYPE_LIST, CEILING_FT_DEFAULT, FT_TO_M, ftIn, pointSeg } from "./shared.js";

const LIMITS = { walls: 400, openings: 200, furniture: 200, stairs: 20, rooms: 60 };

const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const clampN = (v, lo, hi, d) => { const n = num(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const cleanName = (v) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
const furnType = (v) => (FURN_TYPE_LIST.includes(v) ? v : "other");
const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
const cleanScale = (pixelsPerUnit, unit) => {
  const p = num(pixelsPerUnit);
  return Number.isFinite(p) && p > 0.05 && p < 10000 ? { pixelsPerUnit: p, unit: unit === "m" ? "m" : "ft" } : null;
};

// Plan-space helpers, bounded to a margin around the image (w × h px).
function bounds(w, h) {
  const X = (v) => clampN(v, -0.25 * w, 1.25 * w, null), Y = (v) => clampN(v, -0.25 * h, 1.25 * h, null);
  const size = (v, d) => clampN(v, 2, Math.max(w, h) * 1.5, d);
  const deg = (v) => clampN(v, -360, 360, 0);
  return { X, Y, size, deg };
}

// Claude's compact reply { w, d, win, furn, stairs, scale, rooms } -> editor state.
export function planFromModel(p, w, h) {
  const { X, Y, size, deg } = bounds(w, h);
  const rows = (a, n) => list(a, n).filter(Array.isArray);
  const walls = rows(p?.w, LIMITS.walls)
    .map((a) => ({ x1: X(a[0]), y1: Y(a[1]), x2: X(a[2]), y2: Y(a[3]), conf: a.length >= 5 ? clampN(a[4], 0, 1, 1) : 1 }))
    .filter((s) => [s.x1, s.y1, s.x2, s.y2].every((v) => v !== null) && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 1)
    .map((s) => ({ id: nid(), ...s }));
  const ops = (a, type) => rows(a, LIMITS.openings)
    .map((o) => ({ x: X(o[0]), y: Y(o[1]), w: size(o[2], 30), type }))
    .filter((o) => o.x !== null && o.y !== null);
  const openings = [...ops(p?.d, "door"), ...ops(p?.win, "window")].slice(0, LIMITS.openings).map((o) => ({ id: nid(), ...o }));
  const furniture = rows(p?.furn, LIMITS.furniture)
    .map((a) => ({ type: furnType(a[0]), x: X(a[1]), y: Y(a[2]), w: size(a[3], 24), h: size(a[4], 24), deg: deg(a[5]) }))
    .filter((o) => o.x !== null && o.y !== null).map((o) => ({ id: nid(), ...o }));
  const stairs = rows(p?.stairs, LIMITS.stairs)
    .map((a) => ({ x: X(a[0]), y: Y(a[1]), w: size(a[2], 40), h: size(a[3], 60), deg: deg(a[4]) }))
    .filter((o) => o.x !== null && o.y !== null).map((o) => ({ id: nid(), ...o }));
  const rooms = rows(p?.rooms, LIMITS.rooms)
    .map((a) => ({ name: cleanName(a[0]), x: X(a[1]), y: Y(a[2]) }))
    .filter((r) => r.name && r.x !== null && r.y !== null).map((r) => ({ id: nid(), ...r }));
  let scale = null;
  const s = p?.scale;
  if (s && typeof s === "object") {
    const px = num(s.px), len = num(s.len);
    if (px > 0 && len > 0) scale = cleanScale(px / len, s.unit);
  }
  return { walls, openings, furniture, stairs, rooms, scale };
}

// A saved plan, plan file or share link (editor-state shape) -> clean editor state, or null.
export function cleanSavedPlan(p) {
  if (!p || typeof p !== "object") return null;
  const im = p.img && typeof p.img === "object" ? p.img : {};
  const w = clampN(im.w, 50, 8000, 1024), h = clampN(im.h, 50, 8000, 720);
  const url = typeof im.url === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(im.url) && im.url.length < 12_000_000 ? im.url : null;
  const img = { url, w, h, ...(im.blank ? { blank: true } : {}) };
  const { X, Y, size, deg } = bounds(w, h);
  const objs = (a, n) => list(a, n).filter((o) => o && typeof o === "object");
  const walls = objs(p.walls, LIMITS.walls)
    .map((s) => ({ x1: X(s.x1), y1: Y(s.y1), x2: X(s.x2), y2: Y(s.y2), conf: clampN(s.conf, 0, 1, 1) }))
    .filter((s) => [s.x1, s.y1, s.x2, s.y2].every((v) => v !== null) && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 1)
    .map((s) => ({ id: nid(), ...s }));
  const openings = objs(p.openings, LIMITS.openings)
    .map((o) => ({ x: X(o.x), y: Y(o.y), w: size(o.w, 30), type: o.type === "window" ? "window" : "door" }))
    .filter((o) => o.x !== null && o.y !== null).map((o) => ({ id: nid(), ...o }));
  const furniture = objs(p.furniture, LIMITS.furniture)
    .map((o) => ({ type: furnType(o.type), x: X(o.x), y: Y(o.y), w: size(o.w, 24), h: size(o.h, 24), deg: deg(o.deg) }))
    .filter((o) => o.x !== null && o.y !== null).map((o) => ({ id: nid(), ...o }));
  const stairs = objs(p.stairs, LIMITS.stairs)
    .map((o) => ({ x: X(o.x), y: Y(o.y), w: size(o.w, 40), h: size(o.h, 60), deg: deg(o.deg) }))
    .filter((o) => o.x !== null && o.y !== null).map((o) => ({ id: nid(), ...o }));
  const rooms = objs(p.rooms, LIMITS.rooms)
    .map((r) => ({ name: cleanName(r.name), x: X(r.x), y: Y(r.y) }))
    .filter((r) => r.name && r.x !== null && r.y !== null).map((r) => ({ id: nid(), ...r }));
  const scale = p.scale && typeof p.scale === "object" ? cleanScale(p.scale.pixelsPerUnit, p.scale.unit) : null;
  const ceiling = clampN(p.ceiling, 7, 11, CEILING_FT_DEFAULT);
  return { img, walls, openings, furniture, stairs, rooms, scale, ceiling, tidy: p.tidy !== false };
}

// ---------- downloads ----------
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const fileSafe = (s) => (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-plan");

// ---------- plan files ----------
const FILE_TAG = "blueprint-walker-plan";

export function planFileBlob(plan, name) {
  const body = { app: FILE_TAG, v: 1, name: cleanName(name) || "My plan", savedAt: new Date().toISOString(), plan };
  return new Blob([JSON.stringify(body)], { type: "application/json" });
}

// -> { name, plan } or throws Error with a plain-language message
export async function readPlanFile(file) {
  if (file.size > 15_000_000) throw new Error("That file is too big to be a plan file.");
  let body;
  try { body = JSON.parse(await file.text()); } catch { throw new Error("That isn't a Blueprint Walker plan file."); }
  if (!body || body.app !== FILE_TAG) throw new Error("That isn't a Blueprint Walker plan file.");
  const plan = cleanSavedPlan(body.plan);
  if (!plan) throw new Error("That plan file is damaged.");
  return { name: cleanName(body.name) || "Opened plan", plan };
}

// ---------- share links (the plan, without its photo, packed after the # in the address) ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const r1 = (v) => Math.round(v * 10) / 10;

export async function planToHash(plan, name) {
  const lite = {
    n: cleanName(name),
    img: { w: plan.img?.w, h: plan.img?.h, ...(plan.img?.blank ? { blank: true } : {}) },
    walls: plan.walls.map((s) => ({ x1: r1(s.x1), y1: r1(s.y1), x2: r1(s.x2), y2: r1(s.y2), ...(s.conf < 1 ? { conf: s.conf } : {}) })),
    openings: plan.openings.map((o) => ({ x: r1(o.x), y: r1(o.y), w: r1(o.w), type: o.type })),
    furniture: plan.furniture.map((o) => ({ type: o.type, x: r1(o.x), y: r1(o.y), w: r1(o.w), h: r1(o.h), deg: r1(o.deg || 0) })),
    stairs: plan.stairs.map((o) => ({ x: r1(o.x), y: r1(o.y), w: r1(o.w), h: r1(o.h), deg: r1(o.deg || 0) })),
    rooms: plan.rooms.map((r) => ({ name: r.name, x: r1(r.x), y: r1(r.y) })),
    scale: plan.scale, ceiling: plan.ceiling, tidy: plan.tidy,
  };
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(lite)), new CompressionStream("deflate-raw"));
  return "plan=" + b64url(packed);
}

// "#plan=..." -> { name, plan } or null
export async function planFromHash(hash) {
  const m = /^#?plan=([A-Za-z0-9_-]{8,200000})$/.exec(hash || "");
  if (!m) return null;
  try {
    const json = new TextDecoder().decode(await pipe(unb64url(m[1]), new DecompressionStream("deflate-raw")));
    const raw = JSON.parse(json);
    const plan = cleanSavedPlan(raw);
    return plan ? { name: cleanName(raw.n) || "Shared plan", plan } : null;
  } catch { return null; }
}

// ---------- lengths in the user's units ----------
// feet -> "13' 6"" or "4.11 m"
export function fmtLen(feet, units) {
  if (!Number.isFinite(feet)) return "—";
  return units === "m" ? `${(feet * FT_TO_M).toFixed(2)} m` : ftIn(feet);
}
// plan px -> feet (null when no real size is set)
export function pxToFeet(px, scale) {
  if (!scale) return null;
  const inUnit = px / scale.pixelsPerUnit;
  return scale.unit === "ft" ? inUnit : inUnit / FT_TO_M;
}

// ---------- the 2D plan as a picture ----------
// A clean, printable drawing: walls, doors, windows, stairs, furniture, room names, overall size.
export function renderPlanImage(plan, { units = "ft", title = "" } = {}) {
  const walls = plan.walls || [];
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  const grow = (x, y) => { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); };
  walls.forEach((s) => { grow(s.x1, s.y1); grow(s.x2, s.y2); });
  if (!walls.length) { grow(0, 0); grow(plan.img?.w || 800, plan.img?.h || 600); }
  const spanX = Math.max(1, maxx - minx), spanY = Math.max(1, maxy - miny);
  const W = 1600, pad = 90, head = title ? 70 : 20, foot = 60;
  const s = (W - pad * 2) / spanX;
  const H = Math.round(spanY * s + pad * 2 + head + foot);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const P = (px, py) => [pad + (px - minx) * s, head + pad + (py - miny) * s];
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H);
  if (title) { x.fillStyle = "#1d1b2e"; x.font = "600 30px ui-sans-serif, system-ui, sans-serif"; x.textBaseline = "top"; x.fillText(title, pad, 26); }
  const box = (o, fill, stroke) => {
    const [cx, cy] = P(o.x, o.y);
    x.save(); x.translate(cx, cy); x.rotate(((o.deg || 0) * Math.PI) / 180);
    x.fillStyle = fill; x.strokeStyle = stroke; x.lineWidth = 2;
    x.fillRect((-o.w * s) / 2, (-o.h * s) / 2, o.w * s, o.h * s); x.strokeRect((-o.w * s) / 2, (-o.h * s) / 2, o.w * s, o.h * s);
    x.restore();
  };
  (plan.stairs || []).forEach((o) => box(o, "#fdf0e3", "#c2773a"));
  (plan.furniture || []).forEach((o) => box(o, "#eef4f3", "#7aa79f"));
  // walls drawn ~4.7" thick at real scale (0.12 m), kept between 5 and 14 px so they always read
  const wallPx = plan.scale ? (0.12 * plan.scale.pixelsPerUnit) / (plan.scale.unit === "ft" ? FT_TO_M : 1) : 6;
  x.strokeStyle = "#1d1b2e"; x.lineCap = "square"; x.lineWidth = Math.max(5, Math.min(14, wallPx * s));
  walls.forEach((w) => { const [a, b] = P(w.x1, w.y1), [cc, d] = P(w.x2, w.y2); x.beginPath(); x.moveTo(a, b); x.lineTo(cc, d); x.stroke(); });
  // doors: a gap in the wall with a quarter-circle swing; windows: a thin pane set into the wall
  const wallLW = x.lineWidth;
  (plan.openings || []).forEach((o) => {
    let best = null;
    walls.forEach((w) => { const d = pointSeg(o.x, o.y, w.x1, w.y1, w.x2, w.y2); if (!best || d.dist < best.dist) best = { ...d, w }; });
    const [cx, cy] = P(o.x, o.y), half = Math.max(8, (o.w * s) / 2);
    let ux = 1, uy = 0;
    if (best) { const L = Math.hypot(best.w.x2 - best.w.x1, best.w.y2 - best.w.y1) || 1; ux = (best.w.x2 - best.w.x1) / L; uy = (best.w.y2 - best.w.y1) / L; }
    const ax = cx - ux * half, ay = cy - uy * half, bx = cx + ux * half, by = cy + uy * half;
    x.save(); x.lineCap = "butt";
    x.strokeStyle = "#ffffff"; x.lineWidth = wallLW + 6;                                  // cut the gap
    x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
    if (o.type === "door") {
      x.strokeStyle = "#2f9e6e"; x.lineWidth = 2.5;
      const a0 = Math.atan2(uy, ux);
      x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax - uy * half * 2, ay + ux * half * 2); x.stroke();   // the door leaf
      x.setLineDash([6, 5]); x.beginPath(); x.arc(ax, ay, half * 2, a0, a0 + Math.PI / 2); x.stroke(); x.setLineDash([]);
    } else {
      x.strokeStyle = "#2b7fc0"; x.lineWidth = 3;
      [-4, 4].forEach((k) => { x.beginPath(); x.moveTo(ax - uy * k, ay + ux * k); x.lineTo(bx - uy * k, by + ux * k); x.stroke(); });
    }
    x.restore();
  });
  x.textAlign = "center"; x.textBaseline = "middle";
  (plan.rooms || []).forEach((r) => {
    if (!r.name) return; const [cx, cy] = P(r.x, r.y);
    x.font = "600 24px ui-sans-serif, system-ui, sans-serif"; x.fillStyle = "#1d1b2e"; x.fillText(r.name, cx, cy);
  });
  const fw = pxToFeet(spanX, plan.scale), fh = pxToFeet(spanY, plan.scale);
  x.textAlign = "left"; x.textBaseline = "bottom"; x.font = "20px ui-sans-serif, system-ui, sans-serif"; x.fillStyle = "#55536b";
  x.fillText(fw ? `About ${fmtLen(fw, units)} × ${fmtLen(fh, units)} · made with Blueprint Walker` : "Made with Blueprint Walker (real size not set)", pad, H - 22);
  return c;
}
