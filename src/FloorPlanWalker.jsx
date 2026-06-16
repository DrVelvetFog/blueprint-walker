import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as THREE from "three";

/*  Blueprint → Walkable 3D  ·  end-to-end pipeline prototype
    Stages: upload → analyze (Claude vision) → calibrate + correct (2D editor) → walk (Three.js FPS)
    Coordinate spaces:
      - "plan px"  : the downscaled source-image pixel space (origin top-left, y down). All walls/openings stored here.
      - "world m"  : meters in Three.js (x right, z = plan-y, y up). mPerPx = unitMeters / pixelsPerUnit.
*/

// ---------- constants ----------
const MAX_DIM = 1024;          // downscale source image to this max dimension before vision + editing
const CEILING_FT_DEFAULT = 8;  // default ceiling height (ft) — she thinks in feet
const FT_TO_M = 0.3048;
const IN_TO_M = 0.0254;
const WALL_T_M = 0.12;          // interior wall thickness (~4.7")
// Residential door/window standards (inches → m). Doors are 36"×80"; openings get an 80" head.
// Windows sit on a ~32" sill with the head aligned to the door head at 80". Default ADD widths use
// a common 32" interior door and 36" window; widths read from a real drawing are kept as-drawn.
const DOOR_TOP_M = 80 * IN_TO_M;   // door head height (80")
const WIN_SILL_M = 32 * IN_TO_M;   // window sill height (32")
const WIN_TOP_M = 80 * IN_TO_M;    // window head height (80", aligned with doors)
const DOOR_W_M = 32 * IN_TO_M;     // default width when adding a door (32" interior)
const WIN_W_M = 36 * IN_TO_M;      // default width when adding a window (36" general)
const EYE_M = 1.6;              // camera eye height (~63")

// Format a length in decimal feet as plain feet-and-inches, e.g. 13.5 -> 13' 6".
// Rounds to the nearest inch and rolls 12" up to the next foot.
function ftIn(feet) {
  if (!isFinite(feet)) return "—";
  let totalIn = Math.round(feet * 12);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn - ft * 12;
  return inch ? `${ft}' ${inch}"` : `${ft}'`;
}

// How each furniture type is drawn as a simple 3D block: height (m) + color.
const FURN_3D = {
  bed: { h: 0.55, color: 0x6d7fa6 }, sofa: { h: 0.80, color: 0x5f76a0 }, armchair: { h: 0.85, color: 0x5f76a0 },
  chair: { h: 0.90, color: 0x7c6f5a }, table: { h: 0.75, color: 0x9b7653 }, coffee_table: { h: 0.42, color: 0x9b7653 },
  desk: { h: 0.75, color: 0x9b7653 }, dresser: { h: 0.90, color: 0x9b7653 }, nightstand: { h: 0.50, color: 0x9b7653 },
  wardrobe: { h: 2.00, color: 0x8a6a4a }, bookshelf: { h: 1.80, color: 0x8a6a4a }, tv: { h: 1.10, color: 0x2b2b33 },
  toilet: { h: 0.42, color: 0xeef2f5 }, tub: { h: 0.52, color: 0xeef2f5 }, shower: { h: 2.00, color: 0xcfe6f5 },
  sink: { h: 0.85, color: 0xeef2f5 }, counter: { h: 0.90, color: 0xcfc9bb }, stove: { h: 0.90, color: 0x9aa3ad },
  fridge: { h: 1.80, color: 0x9aa3ad }, rug: { h: 0.02, color: 0x8a5a6a }, other: { h: 0.55, color: 0x8a8597 },
};
const FURN_TYPE_LIST = Object.keys(FURN_3D);

// geometry for a furniture/stairs box {x,y,w,h,deg} (deg = clockwise, plan space)
function boxCorners(o) {
  const d = ((o.deg || 0) * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d), hw = o.w / 2, hh = o.h / 2;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ sx, sy, x: o.x + sx * hw * c - sy * hh * s, y: o.y + sx * hw * s + sy * hh * c }));
}
function boxInside(px, py, o) {
  const d = ((o.deg || 0) * Math.PI) / 180, dx = px - o.x, dy = py - o.y;
  const lx = dx * Math.cos(d) + dy * Math.sin(d), ly = -dx * Math.sin(d) + dy * Math.cos(d);
  return Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2;
}

// ---------- small geometry helpers ----------
function pointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t, cx, cy };
}

let _id = 1;
const nid = () => _id++;

// ---------- saved plans (localStorage) ----------
// Client-only persistence so the user can save a plan, leave, and come back to walk it again.
// Lives in localStorage (no server, no new SaaS). Each entry: { id, name, savedAt, thumb, plan }.
const PLANS_KEY = "bw_plans";
function loadPlans() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || "[]"); } catch { return []; } }
function tryPersist(list) { try { localStorage.setItem(PLANS_KEY, JSON.stringify(list)); return true; } catch { return false; } }

// tiny wall-sketch thumbnail (a few KB) so the "My plans" list is recognisable at a glance,
// without re-storing the big background photo as the preview image
function makeThumb(plan, w = 160, h = 120) {
  const walls = plan.walls || [];
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = "#15122e"; x.fillRect(0, 0, w, h);
  if (walls.length) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    walls.forEach((s) => { minx = Math.min(minx, s.x1, s.x2); maxx = Math.max(maxx, s.x1, s.x2); miny = Math.min(miny, s.y1, s.y2); maxy = Math.max(maxy, s.y1, s.y2); });
    const pad = 12, sc = Math.min((w - pad * 2) / ((maxx - minx) || 1), (h - pad * 2) / ((maxy - miny) || 1));
    const ox = (w - (maxx - minx) * sc) / 2 - minx * sc, oy = (h - (maxy - miny) * sc) / 2 - miny * sc;
    x.strokeStyle = "#c7b6ff"; x.lineWidth = 2; x.lineCap = "round";
    walls.forEach((s) => { x.beginPath(); x.moveTo(s.x1 * sc + ox, s.y1 * sc + oy); x.lineTo(s.x2 * sc + ox, s.y2 * sc + oy); x.stroke(); });
  }
  return c.toDataURL("image/jpeg", 0.6);
}

// "Tidy up the drawing": square a wobbly hand trace without destroying deliberate diagonals.
// - right-angle snap: a segment within SNAP_DEG of horizontal/vertical becomes exactly axis-aligned
// - corner weld: endpoints within WELD_PX of each other collapse to their shared centroid (closes loops)
// Pure + index/id-preserving (no merging), so the editor can keep editing the raw walls underneath.
const TIDY_SNAP_DEG = 7;
const TIDY_WELD_PX = 14;
function tidyWalls(walls) {
  const segs = walls.map((w) => ({ id: w.id, conf: w.conf, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
  const snapAngles = () => {
    for (const s of segs) {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      const a = ((Math.atan2(dy, dx) * 180) / Math.PI % 180 + 180) % 180; // 0..180
      if (Math.min(a, 180 - a) <= TIDY_SNAP_DEG) { const my = (s.y1 + s.y2) / 2; s.y1 = my; s.y2 = my; }      // → horizontal
      else if (Math.abs(a - 90) <= TIDY_SNAP_DEG) { const mx = (s.x1 + s.x2) / 2; s.x1 = mx; s.x2 = mx; }      // → vertical
    }
  };
  const weld = () => {
    const pts = [];
    for (const s of segs) { pts.push({ s, k: 1 }); pts.push({ s, k: 2 }); }
    const X = (p) => (p.k === 1 ? p.s.x1 : p.s.x2), Y = (p) => (p.k === 1 ? p.s.y1 : p.s.y2);
    const used = new Array(pts.length).fill(false);
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      const cluster = [i]; used[i] = true;
      for (let j = i + 1; j < pts.length; j++) {
        if (!used[j] && Math.hypot(X(pts[i]) - X(pts[j]), Y(pts[i]) - Y(pts[j])) <= TIDY_WELD_PX) { cluster.push(j); used[j] = true; }
      }
      if (cluster.length > 1) {
        let cx = 0, cy = 0;
        for (const k of cluster) { cx += X(pts[k]); cy += Y(pts[k]); }
        cx /= cluster.length; cy /= cluster.length;
        for (const k of cluster) { const p = pts[k]; if (p.k === 1) { p.s.x1 = cx; p.s.y1 = cy; } else { p.s.x2 = cx; p.s.y2 = cy; } }
      }
    }
  };
  snapAngles(); weld(); snapAngles(); weld(); // settle axes then corners; end on a weld so corners close exactly
  return segs;
}

// ---------- root component ----------
export default function FloorPlanWalker() {
  const [stage, setStage] = useState("upload"); // upload | analyzing | editor | walk
  const [img, setImg] = useState(null);         // { url, w, h }
  const [walls, setWalls] = useState([]);        // { id, x1,y1,x2,y2 } in plan px
  const [openings, setOpenings] = useState([]);  // { id, x,y,w, type:'door'|'window' } center in plan px
  const [furniture, setFurniture] = useState([]); // { id, type, x,y, w,h, deg } center+size in plan px
  const [stairs, setStairs] = useState([]);       // { id, x,y, w,h, deg } stair runs in plan px
  const [rooms, setRooms] = useState([]);          // { id, name, x,y } room labels in plan px
  const [scale, setScale] = useState(null);      // { pixelsPerUnit, unit:'ft'|'m' }
  const [ceiling, setCeiling] = useState(CEILING_FT_DEFAULT); // stored in feet; converted to meters in the 3D walk
  const [tidy, setTidy] = useState(true);        // "Tidy up the drawing": square the trace for display + build
  const [error, setError] = useState(null);
  const [savedPlans, setSavedPlans] = useState(loadPlans); // localStorage-backed "My plans"
  const [currentPlanId, setCurrentPlanId] = useState(null); // the saved entry we're editing, so Save overwrites it
  const [currentName, setCurrentName] = useState("");       // its name (prefilled into the Save box)
  const [saveStatus, setSaveStatus] = useState("");         // transient "Saved ✓" / quota message
  const [showIntro, setShowIntro] = useState(() => { try { return !localStorage.getItem("bw_intro_seen"); } catch { return false; } });
  const closeIntro = () => { try { localStorage.setItem("bw_intro_seen", "1"); } catch {} setShowIntro(false); };

  // squared walls used for the 3D build and the editor's "after" preview; raw walls stay editable
  const tidied = useMemo(() => (tidy ? tidyWalls(walls) : walls), [tidy, walls]);

  // ---- undo history ----
  // Each entry snapshots the editable state BEFORE a discrete action. Every update is immutable
  // (new arrays/objects), so we can store references cheaply without deep-copying.
  const historyRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const pushHistory = useCallback(() => {
    const h = historyRef.current;
    h.push({ walls, openings, furniture, stairs, rooms, scale, ceiling });
    if (h.length > 60) h.shift();
    setCanUndo(true);
  }, [walls, openings, furniture, stairs, rooms, scale, ceiling]);
  const undo = useCallback(() => {
    const s = historyRef.current.pop();
    if (!s) return;
    setWalls(s.walls); setOpenings(s.openings); setFurniture(s.furniture);
    setStairs(s.stairs); setRooms(s.rooms); setScale(s.scale); setCeiling(s.ceiling);
    setCanUndo(historyRef.current.length > 0);
  }, []);
  // Ctrl/Cmd+Z in the editor (ignore while typing in a field)
  useEffect(() => {
    const onKey = (e) => {
      if (stage !== "editor" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if (e.key !== "z" && e.key !== "Z") return;
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      e.preventDefault(); undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, stage]);

  // ---- image intake (downscale to a consistent working resolution) ----
  const ingest = useCallback((file) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const im = new Image();
      im.onload = () => {
        const s = Math.min(1, MAX_DIM / Math.max(im.width, im.height));
        const w = Math.round(im.width * s), h = Math.round(im.height * s);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const cx = c.getContext("2d");
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
        cx.drawImage(im, 0, 0, w, h);
        setImg({ url: c.toDataURL("image/jpeg", 0.9), w, h });
        setWalls([]); setOpenings([]); setFurniture([]); setStairs([]); setRooms([]); setScale(null);
        setCurrentPlanId(null); setCurrentName(""); setSaveStatus(""); // a fresh photo is a new (unsaved) plan
        historyRef.current = []; setCanUndo(false);
      };
      im.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }, []);

  // ---- vision extraction via the key-safe server function ----
  // The browser only ever POSTs the image to our own /.netlify/functions/extract-plan.
  // That function (server-side) does the actual vision call and returns the plan JSON
  // contract: { w, d, win, scale, rooms }. The Anthropic key stays server-side, never in the client.
  const analyze = useCallback(async () => {
    if (!img) return;
    setStage("analyzing"); setError(null);
    const base64 = img.url.split(",")[1];
    try {
      const res = await fetch("/.netlify/functions/extract-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mediaType: "image/jpeg", width: img.w, height: img.h }),
      });
      const p = await res.json();              // -> { w, d, win, furn, stairs, scale, rooms } | { error }
      if (!res.ok || p.error) throw new Error(p.error || ("server " + res.status));
      // walls: 5th element (conf 0–1) is optional/additive — older 4-element responses default to confident
      const nw = (p.w || []).filter(a => Array.isArray(a) && a.length >= 4)
        .map(a => ({ id: nid(), x1: a[0], y1: a[1], x2: a[2], y2: a[3], conf: (a.length >= 5 && isFinite(a[4])) ? Math.max(0, Math.min(1, a[4])) : 1 }));
      const no = [
        ...(p.d || []).map(a => ({ id: nid(), x: a[0], y: a[1], w: a[2] || 30, type: "door" })),
        ...(p.win || []).map(a => ({ id: nid(), x: a[0], y: a[1], w: a[2] || 30, type: "window" })),
      ];
      // furniture / stairs / rooms are additive: older responses omit them and still work
      const nf = (p.furn || []).filter(a => Array.isArray(a) && a.length >= 5)
        .map(a => ({ id: nid(), type: String(a[0] || "other"), x: a[1], y: a[2], w: a[3] || 24, h: a[4] || 24, deg: a[5] || 0 }));
      const ns = (p.stairs || []).filter(a => Array.isArray(a) && a.length >= 4)
        .map(a => ({ id: nid(), x: a[0], y: a[1], w: a[2] || 40, h: a[3] || 60, deg: a[4] || 0 }));
      const nr = (p.rooms || []).filter(a => Array.isArray(a) && a.length >= 3)
        .map(a => ({ id: nid(), name: String(a[0] || ""), x: a[1], y: a[2] }));
      setWalls(nw); setOpenings(no); setFurniture(nf); setStairs(ns); setRooms(nr);
      if (p.scale && p.scale.px && p.scale.len) {
        setScale({ pixelsPerUnit: p.scale.px / p.scale.len, unit: p.scale.unit === "m" ? "m" : "ft" });
      }
      setStage("editor");
    } catch (err) {
      setError("That photo was a little hard to read — try again in good light, or just draw the walls yourself with the tools below.");
      setStage("editor");
    }
  }, [img]);

  const loadSample = useCallback(() => {
    // simple 2-bed shell sized for a 1024-wide canvas
    setImg({ url: null, w: 1024, h: 720 });
    const W = (x1, y1, x2, y2) => ({ id: nid(), x1, y1, x2, y2 });
    setWalls([
      W(120, 120, 904, 120), W(904, 120, 904, 600), W(904, 600, 120, 600), W(120, 600, 120, 120), // outer
      { ...W(512, 120, 512, 360), conf: 0.3 }, // hall divider — demo of an "uncertain" wall (orange/dashed)
      W(120, 360, 512, 360), // bed1 bottom
      W(512, 360, 904, 360), // bed2 bottom
      W(360, 360, 360, 600), // bath wall
    ]);
    setOpenings([
      { id: nid(), x: 512, y: 600, w: 60, type: "door" },  // front door
      { id: nid(), x: 316, y: 360, w: 45, type: "door" },
      { id: nid(), x: 700, y: 360, w: 45, type: "door" },
      { id: nid(), x: 360, y: 480, w: 40, type: "door" },
      { id: nid(), x: 250, y: 120, w: 70, type: "window" },
      { id: nid(), x: 700, y: 120, w: 70, type: "window" },
      { id: nid(), x: 904, y: 480, w: 70, type: "window" },
    ]);
    setFurniture([
      { id: nid(), type: "bed", x: 300, y: 235, w: 150, h: 110, deg: 0 },
      { id: nid(), type: "bed", x: 712, y: 235, w: 150, h: 110, deg: 0 },
      { id: nid(), type: "tub", x: 250, y: 440, w: 60, h: 120, deg: 0 },
      { id: nid(), type: "toilet", x: 250, y: 560, w: 36, h: 50, deg: 0 },
      { id: nid(), type: "sofa", x: 700, y: 500, w: 190, h: 70, deg: 0 },
      { id: nid(), type: "table", x: 460, y: 480, w: 90, h: 60, deg: 0 },
    ]);
    setStairs([{ id: nid(), x: 450, y: 220, w: 90, h: 150, deg: 0 }]);
    setRooms([
      { id: nid(), name: "Bedroom", x: 300, y: 250 },
      { id: nid(), name: "Bedroom", x: 712, y: 250 },
      { id: nid(), name: "Bath", x: 250, y: 500 },
      { id: nid(), name: "Living", x: 700, y: 470 },
    ]);
    setScale({ pixelsPerUnit: 1024 / 12, unit: "m" }); // assume 12 m wide
    setCurrentPlanId(null); setCurrentName(""); setSaveStatus("");
    historyRef.current = []; setCanUndo(false);
    setStage("editor");
  }, []);

  // rotate the whole plan 90° clockwise — photo + every traced piece together, so they stay aligned
  const rotatePlan = useCallback(() => {
    if (!img) return;
    const oldH = img.h;
    const rot = (x, y) => [oldH - y, x]; // 90° CW; new plan size is (oldH × oldW)
    const apply = (url) => {
      setImg({ url, w: img.h, h: img.w, blank: img.blank });
      setWalls((a) => a.map((w) => { const [x1, y1] = rot(w.x1, w.y1), [x2, y2] = rot(w.x2, w.y2); return { ...w, x1, y1, x2, y2 }; }));
      setOpenings((a) => a.map((q) => { const [x, y] = rot(q.x, q.y); return { ...q, x, y }; }));
      setFurniture((a) => a.map((q) => { const [x, y] = rot(q.x, q.y); return { ...q, x, y, deg: ((q.deg || 0) + 90) % 360 }; }));
      setStairs((a) => a.map((q) => { const [x, y] = rot(q.x, q.y); return { ...q, x, y, deg: ((q.deg || 0) + 90) % 360 }; }));
      setRooms((a) => a.map((q) => { const [x, y] = rot(q.x, q.y); return { ...q, x, y }; }));
    };
    if (img.url) {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.h; c.height = img.w;            // swapped dimensions
        const ctx = c.getContext("2d");
        ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(im, 0, 0);
        apply(c.toDataURL("image/jpeg", 0.9));
      };
      im.src = img.url;
    } else apply(null); // blank/sample: rotate coords only
  }, [img]);

  // start from a blank 1-ft grid (no photo) — everything she draws is already to scale
  const startBlank = useCallback(() => {
    const PXFT = 24; // pixels per foot of the blank canvas (1 grid square)
    setImg({ url: null, w: 40 * PXFT, h: 30 * PXFT, blank: true }); // ~40ft × 30ft drawing area
    setWalls([]); setOpenings([]); setFurniture([]); setStairs([]); setRooms([]);
    setScale({ pixelsPerUnit: PXFT, unit: "ft" }); // 1 square = 1 ft, baked in
    setCurrentPlanId(null); setCurrentName(""); setSaveStatus("");
    historyRef.current = []; setCanUndo(false);
    setStage("editor");
  }, []);

  // ---- save / revisit (Phase 7) ----
  // Save the current plan under a name. Overwrites the open saved entry if there is one,
  // else creates a new one. If localStorage is full, retry without the (big) background photo.
  const savePlan = useCallback((name) => {
    const plan = { img, walls, openings, furniture, stairs, rooms, scale, ceiling, tidy };
    const id = currentPlanId || ("p" + Date.now());
    const others = savedPlans.filter((p) => p.id !== id);
    const mk = (pl, dropped) => ({ id, name: (name || "").trim() || "My plan", savedAt: Date.now(), thumb: makeThumb(pl), plan: pl, photoDropped: !!dropped });
    let entry = mk(plan, false);
    let next = [entry, ...others].sort((a, b) => b.savedAt - a.savedAt);
    if (tryPersist(next)) setSaveStatus("Saved ✓");
    else {
      const lite = { ...plan, img: plan.img ? { ...plan.img, url: null } : plan.img }; // drop the photo to fit
      entry = mk(lite, true);
      next = [entry, ...others].sort((a, b) => b.savedAt - a.savedAt);
      if (tryPersist(next)) setSaveStatus("Saved (without the photo, to save space).");
      else { setSaveStatus("Storage is full — delete a saved plan and try again."); return; }
    }
    setSavedPlans(next); setCurrentPlanId(id); setCurrentName(entry.name);
  }, [img, walls, openings, furniture, stairs, rooms, scale, ceiling, tidy, currentPlanId, savedPlans]);

  // Open a saved plan back into the editor (or straight into the walk). Re-id every piece via nid()
  // so the session's id counter can never collide with ids saved in a previous session.
  const openPlan = useCallback((entry, walk) => {
    const p = entry.plan || {};
    const remap = (arr) => (arr || []).map((o) => ({ ...o, id: nid() }));
    setImg(p.img || null);
    setWalls(remap(p.walls)); setOpenings(remap(p.openings));
    setFurniture(remap(p.furniture)); setStairs(remap(p.stairs)); setRooms(remap(p.rooms));
    setScale(p.scale || null); setCeiling(p.ceiling ?? CEILING_FT_DEFAULT); setTidy(p.tidy ?? true);
    setCurrentPlanId(entry.id); setCurrentName(entry.name); setSaveStatus(""); setError(null);
    historyRef.current = []; setCanUndo(false);
    setStage(walk && (p.walls || []).length >= 3 ? "walk" : "editor");
  }, []);

  const renamePlan = useCallback((id, name) => {
    const clean = (name || "").trim(); if (!clean) return;
    setSavedPlans((list) => { const next = list.map((p) => p.id === id ? { ...p, name: clean } : p); tryPersist(next); return next; });
    setCurrentName((cn) => (id === currentPlanId ? clean : cn));
  }, [currentPlanId]);

  const deletePlan = useCallback((id) => {
    setSavedPlans((list) => { const next = list.filter((p) => p.id !== id); tryPersist(next); return next; });
    if (id === currentPlanId) { setCurrentPlanId(null); setCurrentName(""); }
  }, [currentPlanId]);

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
      className="w-full min-h-screen text-slate-100"
    >
      <div className="min-h-screen w-full" style={{ background: "radial-gradient(1200px 600px at 70% -10%, #2a1f5e 0%, #15122e 45%, #0c0a1f 100%)" }}>
        {showIntro && <Welcome onClose={closeIntro} />}
        <Header stage={stage} onHelp={() => setShowIntro(true)} />
        {stage === "upload" && (
          <Upload img={img} onFile={ingest} onAnalyze={analyze} onSample={loadSample} onBlank={startBlank} onReset={() => setImg(null)}
            savedPlans={savedPlans} onOpenPlan={openPlan} onRenamePlan={renamePlan} onDeletePlan={deletePlan} />
        )}
        {stage === "analyzing" && <Analyzing />}
        {stage === "editor" && (
          <Editor
            img={img} walls={walls} setWalls={setWalls} tidied={tidied} tidy={tidy} setTidy={setTidy}
            openings={openings} setOpenings={setOpenings}
            furniture={furniture} setFurniture={setFurniture}
            stairs={stairs} setStairs={setStairs}
            rooms={rooms} setRooms={setRooms}
            scale={scale} setScale={setScale}
            ceiling={ceiling} setCeiling={setCeiling}
            error={error} onRotate={rotatePlan}
            savedName={currentName} onSave={savePlan} saveStatus={saveStatus}
            onUndo={undo} canUndo={canUndo} onPushHistory={pushHistory}
            onWalk={() => setStage("walk")}
            onBack={() => { setStage("upload"); }}
          />
        )}
        {stage === "walk" && (
          <Walk walls={tidied} openings={openings} furniture={furniture} stairs={stairs} rooms={rooms} scale={scale} ceiling={ceiling} onExit={() => setStage("editor")} />
        )}
      </div>
    </div>
  );
}

// ---------- first-open tutorial ----------
function Welcome({ onClose }) {
  const steps = [
    ["📷", "Add your plan", "Snap a photo of a floor plan — a sketch on paper is perfect — or start a blank grid and draw one."],
    ["✨", "We trace it", "We find the walls, doors, windows, and furniture for you."],
    ["✏️", "Fix it up", "Tap any piece to move, resize, or delete it. Pinch to zoom in for the small stuff."],
    ["🚶", "Walk it", "Step inside and walk around your space in 3D."],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: "rgba(8,6,20,0.72)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: "#15122e", border: "1px solid rgba(255,255,255,0.12)" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-semibold mb-1" style={{ color: "#c7b6ff" }}>Welcome 👋</h2>
        <p className="text-slate-400 text-sm mb-5">Turn a floor plan into a space you can walk through — in four steps:</p>
        <div className="flex flex-col gap-3.5 mb-6">
          {steps.map(([icon, title, body], i) => (
            <div key={i} className="flex gap-3">
              <div className="text-xl leading-none mt-0.5">{icon}</div>
              <div>
                <div className="text-slate-100 font-medium text-sm">{i + 1}. {title}</div>
                <div className="text-slate-400 text-xs leading-relaxed">{body}</div>
              </div>
            </div>
          ))}
        </div>
        <button onClick={onClose} className="w-full py-2.5 rounded-lg text-sm font-semibold text-white" style={{ background: "#6d5ae6" }}>Get started</button>
      </div>
    </div>
  );
}

// ---------- header ----------
function Header({ stage, onHelp }) {
  const steps = [["upload", "Add plan"], ["analyzing", "Reading"], ["editor", "Fix it up"], ["walk", "Walk it"]];
  const idx = { upload: 0, analyzing: 1, editor: 2, walk: 3 }[stage];
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 backdrop-blur"
      style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="flex items-baseline gap-3">
        <span className="text-base font-semibold tracking-tight" style={{ color: "#c7b6ff" }}>Blueprint Walker</span>
        <span className="text-xs text-slate-400 hidden sm:inline">your floor plan, as a space you can walk through</span>
      </div>
      <div className="flex items-center gap-2">
        {steps.map(([k, label], i) => (
          <div key={k} className="flex items-center gap-2">
            <span className={"text-[11px] px-2 py-1 rounded-full " + (i <= idx ? "text-white" : "text-slate-500")}
              style={{ background: i <= idx ? "rgba(124,99,255,0.25)" : "transparent", border: "1px solid " + (i <= idx ? "rgba(124,99,255,0.5)" : "rgba(255,255,255,0.08)") }}>
              {i + 1}. {label}
            </span>
            {i < steps.length - 1 && <span className="text-slate-600 text-xs">→</span>}
          </div>
        ))}
        <button onClick={onHelp} title="How it works" aria-label="How it works"
          className="ml-1 w-7 h-7 rounded-full text-sm text-slate-200 flex items-center justify-center shrink-0"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)" }}>?</button>
      </div>
    </div>
  );
}

// ---------- upload ----------
function Upload({ img, onFile, onAnalyze, onSample, onBlank, onReset, savedPlans = [], onOpenPlan, onRenamePlan, onDeletePlan }) {
  const fileRef = useRef(null), camRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const drop = (e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); };

  return (
    <div className="max-w-3xl mx-auto px-5 py-10">
      {!img ? (
        <>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-2">Turn a drawing into a space you can walk through.</h1>
          <p className="text-slate-400 mb-7 text-sm">Take a photo of a floor plan — even a rough sketch on paper. We'll trace the walls for you, you fix anything that looks off, tell us the real size, then walk through your space.</p>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={drop}
            className="rounded-2xl p-10 text-center transition"
            style={{ border: "1.5px dashed " + (drag ? "#7c63ff" : "rgba(255,255,255,0.15)"), background: drag ? "rgba(124,99,255,0.08)" : "rgba(255,255,255,0.02)" }}
          >
            <div className="text-slate-300 mb-4 text-sm">Drag a plan here, or</div>
            <div className="flex flex-wrap gap-3 justify-center">
              <button onClick={() => fileRef.current?.click()} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: "#6d5ae6" }}>Choose file</button>
              <button onClick={() => camRef.current?.click()} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}>Take a photo</button>
              <button onClick={onBlank} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: "rgba(124,255,203,0.14)", border: "1px solid rgba(124,255,203,0.4)" }}>Draw a new plan</button>
              <button onClick={onSample} className="px-4 py-2 rounded-lg text-sm font-medium text-slate-200" style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)" }}>Try a sample</button>
            </div>
            <div className="text-slate-500 text-xs mt-4">“Draw a new plan” gives you a blank grid where 1 square = 1 foot — no photo needed.</div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </div>
          {savedPlans.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-medium text-slate-300 mb-3">My plans</h2>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                {savedPlans.map((p) => (
                  <div key={p.id} className="rounded-xl overflow-hidden flex flex-col" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.12)" }}>
                    <button onClick={() => onOpenPlan?.(p, false)} title="Open this plan" className="block w-full">
                      <img src={p.thumb} alt={p.name} className="w-full block" style={{ aspectRatio: "4 / 3", objectFit: "cover" }} />
                    </button>
                    <div className="px-2.5 py-2 flex flex-col gap-2">
                      <div className="min-w-0">
                        <div className="text-sm text-slate-100 truncate">{p.name}</div>
                        <div className="text-[11px] text-slate-500">{new Date(p.savedAt).toLocaleDateString()}{p.photoDropped ? " · no photo" : ""}</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => onOpenPlan?.(p, false)} className="flex-1 px-2 py-1 rounded text-xs font-medium text-white" style={{ background: "#6d5ae6" }}>Open</button>
                        <button onClick={() => onOpenPlan?.(p, true)} title="Walk it now" className="px-2 py-1 rounded text-xs text-white" style={{ background: "rgba(124,255,203,0.16)", border: "1px solid rgba(124,255,203,0.4)" }}>Walk</button>
                        <button onClick={() => { const n = window.prompt("Rename this plan:", p.name); if (n != null) onRenamePlan?.(p.id, n); }} title="Rename" className="px-2 py-1 rounded text-xs text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>✎</button>
                        <button onClick={() => { if (window.confirm(`Delete “${p.name}”? This can't be undone.`)) onDeletePlan?.(p.id); }} title="Delete" className="px-2 py-1 rounded text-xs" style={{ background: "rgba(180,68,78,0.18)", border: "1px solid rgba(180,68,78,0.4)", color: "#ffb4ba" }}>🗑</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-center">
          <h2 className="text-lg font-medium mb-4">Looks good — ready when you are.</h2>
          <div className="inline-block rounded-xl overflow-hidden mb-5" style={{ border: "1px solid rgba(255,255,255,0.12)", maxWidth: "100%" }}>
            {img.url ? <img src={img.url} alt="floor plan" style={{ maxHeight: 420, display: "block" }} /> : <div className="px-16 py-12 text-slate-400">sample plan loaded</div>}
          </div>
          <div className="flex gap-3 justify-center">
            <button onClick={onAnalyze} className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white" style={{ background: "#6d5ae6" }}>Trace my plan →</button>
            <button onClick={onReset} className="px-4 py-2.5 rounded-lg text-sm text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>Use a different image</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Analyzing() {
  return (
    <div className="max-w-xl mx-auto px-5 py-24 text-center">
      <div className="inline-block w-10 h-10 rounded-full mb-5 animate-spin" style={{ border: "3px solid rgba(124,99,255,0.25)", borderTopColor: "#a48bff" }} />
      <p className="text-slate-300">Reading your plan…</p>
      <p className="text-slate-500 text-xs mt-2">Finding the walls, doors, and windows — you'll get to fix anything next.</p>
    </div>
  );
}

// ================= 2D EDITOR =================
function Editor({ img, walls, setWalls, tidied = [], tidy = false, setTidy, openings, setOpenings, furniture = [], setFurniture, stairs = [], setStairs, rooms = [], setRooms, scale, setScale, ceiling, setCeiling, error, onRotate, savedName = "", onSave, saveStatus = "", onUndo, canUndo = false, onPushHistory, onWalk, onBack }) {
  const canvasRef = useRef(null);
  const [saving, setSaving] = useState(false);          // inline "name this plan" panel open?
  const [nameDraft, setNameDraft] = useState(savedName); // editable name in the Save panel
  const wrapRef = useRef(null);
  const tf = useRef({ s: 1, ox: 0, oy: 0, cos: 1, sin: 0 }); // plan→screen similarity transform (fit × zoom/pan/rotate)
  const fit = useRef({ s: 1, ox: 0, oy: 0 });      // base "whole plan fits" transform
  const view = useRef({ zoom: 1, panx: 0, pany: 0, rot: 0 }); // user zoom (≥1) + pan + free rotation, on top of the fit
  const drag = useRef(null);                       // active interaction
  const gesture = useRef(null);                    // active two-finger pinch/pan
  const [tool, setTool] = useState("move");
  const [showImg, setShowImg] = useState(true);
  const [selected, setSelected] = useState(null); // { kind:'furn'|'stair', id } currently-selected box
  const [scaleDraft, setScaleDraft] = useState(null); // {x1,y1,x2,y2}
  const [scaleMode, setScaleMode] = useState("grid"); // "grid" (1 square = N ft) | "wall" (known length)
  const [scaleInput, setScaleInput] = useState({ len: "", unit: scale?.unit || "ft", squares: "", ftPerSq: 1 });
  const [size, setSize] = useState({ w: 800, h: 560 });
  const bg = useRef(null);

  // load source image once for the faded background
  useEffect(() => {
    if (img?.url) { const i = new Image(); i.onload = () => { bg.current = i; draw(); }; i.src = img.url; }
    else bg.current = null;
  }, [img]);

  // reset zoom/pan/rotation when the plan changes
  useEffect(() => { view.current = { zoom: 1, panx: 0, pany: 0, rot: 0 }; }, [img]);

  // size canvas to its container
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current; if (!el) return;
      setSize({ w: el.clientWidth, h: Math.max(360, Math.min(640, el.clientWidth * (img ? img.h / img.w : 0.66))) });
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [img]);

  // compute transform: base fit, then the user's zoom + pan (around canvas center), then a free
  // rotation about that center — a similarity transform screen = R(θ)·s·plan + offset (map-like).
  const recompute = useCallback(() => {
    if (!img) return;
    const pad = 20;
    const s0 = Math.min((size.w - pad * 2) / img.w, (size.h - pad * 2) / img.h);
    fit.current = { s: s0, ox: (size.w - img.w * s0) / 2, oy: (size.h - img.h * s0) / 2 };
    const z = view.current.zoom;
    // keep part of the plan on screen
    const halfW = (img.w * s0 * z) / 2 + size.w / 2, halfH = (img.h * s0 * z) / 2 + size.h / 2;
    view.current.panx = Math.max(-halfW, Math.min(halfW, view.current.panx));
    view.current.pany = Math.max(-halfH, Math.min(halfH, view.current.pany));
    const cx = size.w / 2, cy = size.h / 2;
    // axis-aligned offset (no rotation) for the fit×zoom×pan stack
    const ox0 = cx + (fit.current.ox - cx) * z + view.current.panx;
    const oy0 = cy + (fit.current.oy - cy) * z + view.current.pany;
    // rotate the whole view about the canvas center by θ
    const th = view.current.rot || 0, cos = Math.cos(th), sin = Math.sin(th);
    const ox = cx + cos * (ox0 - cx) - sin * (oy0 - cy);
    const oy = cy + sin * (ox0 - cx) + cos * (oy0 - cy);
    tf.current = { s: s0 * z, ox, oy, cos, sin };
  }, [img, size]);

  const toScreen = (x, y) => ({
    x: tf.current.ox + tf.current.s * (tf.current.cos * x - tf.current.sin * y),
    y: tf.current.oy + tf.current.s * (tf.current.sin * x + tf.current.cos * y),
  });
  const toPlan = (sx, sy) => {
    const dx = sx - tf.current.ox, dy = sy - tf.current.oy, s = tf.current.s || 1;
    return { x: (tf.current.cos * dx + tf.current.sin * dy) / s, y: (-tf.current.sin * dx + tf.current.cos * dy) / s };
  };

  // ---- draw ----
  const draw = useCallback(() => {
    const c = canvasRef.current; if (!c || !img) return;
    recompute();
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr; c.height = size.h * dpr;
    c.style.width = size.w + "px"; c.style.height = size.h + "px";
    const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, size.w, size.h);
    // backdrop
    x.fillStyle = "rgba(255,255,255,0.02)"; x.fillRect(0, 0, size.w, size.h);
    if (bg.current && showImg) {
      x.save();
      x.globalAlpha = 0.45;
      x.translate(tf.current.ox, tf.current.oy); x.rotate(view.current.rot || 0);
      x.drawImage(bg.current, 0, 0, img.w * tf.current.s, img.h * tf.current.s);
      x.restore();
      x.globalAlpha = 1;
    }
    // blank-canvas reference grid (no photo): one line per scale-unit (1 ft in "Draw a new plan")
    if (!bg.current && scale && img && scale.pixelsPerUnit * tf.current.s > 4) {
      const step = scale.pixelsPerUnit;
      x.strokeStyle = "rgba(199,182,255,0.10)"; x.lineWidth = 1; x.beginPath();
      for (let gx = 0; gx <= img.w + 0.5; gx += step) { const a = toScreen(gx, 0), b = toScreen(gx, img.h); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); }
      for (let gy = 0; gy <= img.h + 0.5; gy += step) { const a = toScreen(0, gy), b = toScreen(img.w, gy); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); }
      x.stroke();
    }
    // furniture (drawn under the walls): translucent boxes with a type label
    furniture.forEach((f) => {
      const c = toScreen(f.x, f.y);
      const w = f.w * tf.current.s, h = f.h * tf.current.s;
      x.save(); x.translate(c.x, c.y); x.rotate((f.deg || 0) * Math.PI / 180 + (view.current.rot || 0));
      x.fillStyle = "rgba(94,234,212,0.14)"; x.strokeStyle = "rgba(94,234,212,0.75)"; x.lineWidth = 1.5;
      x.beginPath(); x.rect(-w / 2, -h / 2, w, h); x.fill(); x.stroke();
      x.restore();
      x.fillStyle = "rgba(190,255,242,0.92)"; x.font = "10px ui-sans-serif, system-ui, sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(f.type, c.x, c.y);
    });
    // staircases: amber box with tread hints + label (a feature, never a wall)
    stairs.forEach((s) => {
      const c = toScreen(s.x, s.y);
      const w = s.w * tf.current.s, h = s.h * tf.current.s;
      x.save(); x.translate(c.x, c.y); x.rotate((s.deg || 0) * Math.PI / 180 + (view.current.rot || 0));
      x.fillStyle = "rgba(251,146,60,0.16)"; x.strokeStyle = "rgba(251,146,60,0.8)"; x.lineWidth = 1.5;
      x.beginPath(); x.rect(-w / 2, -h / 2, w, h); x.fill(); x.stroke();
      const n = Math.max(2, Math.min(12, Math.round(Math.max(w, h) / 12)));
      x.beginPath();
      for (let i = 1; i < n; i++) { const yy = -h / 2 + (h * i / n); x.moveTo(-w / 2, yy); x.lineTo(w / 2, yy); }
      x.stroke(); x.restore();
      x.fillStyle = "rgba(255,221,180,0.95)"; x.font = "10px ui-sans-serif, system-ui, sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText("stairs ↑", c.x, c.y);
    });
    // walls — when tidy is on, draw the raw trace faint (still draggable) and the squared
    // result bold on top, so "before vs after" is visible; otherwise the raw walls are the bold layer.
    x.lineCap = "round";
    const overlay = tidy && tidied.length > 0;
    const selWallId = selected?.kind === "wall" ? selected.id : null;
    const selOpenId = selected?.kind === "opening" ? selected.id : null;
    const UNC = "#fbbf24";                       // walls the model wasn't sure about → amber + dashed
    const isUnc = (w) => (w.conf ?? 1) < 0.6;    // missing conf (older plans) = confident
    walls.forEach((w) => {
      const a = toScreen(w.x1, w.y1), b = toScreen(w.x2, w.y2);
      const isSel = w.id === selWallId, unc = isUnc(w);
      // raw layer: bold when tidy is off, a faint underlay when the squared overlay is on
      if (overlay) { x.strokeStyle = unc ? "rgba(251,191,36,0.32)" : "rgba(199,182,255,0.28)"; x.lineWidth = 2; x.setLineDash([]); }
      else if (isSel) { x.strokeStyle = "#7CFFCB"; x.lineWidth = 6; x.setLineDash([]); }
      else if (unc) { x.strokeStyle = UNC; x.lineWidth = 5; x.setLineDash([9, 7]); }
      else { x.strokeStyle = "#c7b6ff"; x.lineWidth = 5; x.setLineDash([]); }
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.setLineDash([]);
      [a, b].forEach((p) => { x.fillStyle = isSel ? "#7CFFCB" : "#1b1640"; x.strokeStyle = isSel ? "#0c0a1f" : (unc && !overlay ? UNC : "#a48bff"); x.lineWidth = 2;
        x.beginPath(); x.rect(p.x - (isSel ? 5 : 4), p.y - (isSel ? 5 : 4), isSel ? 10 : 8, isSel ? 10 : 8); x.fill(); x.stroke(); });
    });
    if (overlay) {
      tidied.forEach((w) => {
        const a = toScreen(w.x1, w.y1), b = toScreen(w.x2, w.y2);
        const isSel = w.id === selWallId, unc = isUnc(w);
        x.strokeStyle = isSel ? "#7CFFCB" : (unc ? UNC : "#c7b6ff"); x.lineWidth = isSel ? 6 : 5;
        x.setLineDash(unc && !isSel ? [9, 7] : []);
        x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.setLineDash([]);
      });
    }
    // draft wall
    if (drag.current?.type === "newwall") {
      const dc = drag.current;
      const a = toScreen(dc.x1, dc.y1), b = toScreen(dc.x2, dc.y2);
      x.strokeStyle = "#7CFFCB"; x.lineWidth = 4; x.setLineDash([6, 5]);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.setLineDash([]);
      // ring the end(s) snapped onto an existing corner, so the connection is obvious
      [[dc.snapStart, a], [dc.snapEnd, b]].forEach(([on, p]) => { if (on) { x.strokeStyle = "#7CFFCB"; x.lineWidth = 2; x.beginPath(); x.arc(p.x, p.y, 9, 0, 7); x.stroke(); } });
    }
    // openings
    openings.forEach((o) => {
      const p = toScreen(o.x, o.y);
      const isSel = o.id === selOpenId;
      if (isSel) { x.strokeStyle = "#7CFFCB"; x.lineWidth = 2.5; x.beginPath(); x.arc(p.x, p.y, 11, 0, 7); x.stroke(); }
      x.fillStyle = o.type === "door" ? "#34d399" : "#38bdf8";
      x.beginPath(); x.arc(p.x, p.y, isSel ? 7 : 6, 0, Math.PI * 2); x.fill();
      x.strokeStyle = "rgba(0,0,0,0.4)"; x.lineWidth = 1.5; x.stroke();
    });
    // room name labels (on top), with a soft pill behind for legibility
    rooms.forEach((r) => {
      if (!r.name) return;
      const c = toScreen(r.x, r.y);
      x.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle";
      const tw = x.measureText(r.name).width;
      x.fillStyle = "rgba(12,10,31,0.55)";
      x.beginPath(); x.rect(c.x - tw / 2 - 6, c.y - 10, tw + 12, 20); x.fill();
      x.fillStyle = "#ece9f5"; x.fillText(r.name, c.x, c.y);
    });
    // scale draft
    const sd = scaleDraft;
    if (sd) {
      const a = toScreen(sd.x1, sd.y1), b = toScreen(sd.x2, sd.y2);
      x.strokeStyle = "#fbbf24"; x.lineWidth = 3; x.setLineDash([5, 4]);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.setLineDash([]);
      [a, b].forEach((p) => { x.fillStyle = "#fbbf24"; x.beginPath(); x.arc(p.x, p.y, 4, 0, 7); x.fill(); });
    }
    // selection highlight + corner resize handles
    if (selected) {
      const b = boxList().find((b) => b.kind === selected.kind && b.o.id === selected.id);
      if (b) {
        const o = b.o, c = toScreen(o.x, o.y), w = o.w * tf.current.s, h = o.h * tf.current.s;
        x.save(); x.translate(c.x, c.y); x.rotate((o.deg || 0) * Math.PI / 180 + (view.current.rot || 0));
        x.strokeStyle = "#7CFFCB"; x.lineWidth = 2; x.setLineDash([5, 3]);
        x.strokeRect(-w / 2, -h / 2, w, h); x.setLineDash([]); x.restore();
        boxCorners(o).forEach((cn) => { const p = toScreen(cn.x, cn.y); x.fillStyle = "#7CFFCB"; x.strokeStyle = "#0c0a1f"; x.lineWidth = 1.5; x.beginPath(); x.rect(p.x - 5, p.y - 5, 10, 10); x.fill(); x.stroke(); });
      }
    }
  }, [img, size, walls, tidied, tidy, openings, furniture, stairs, rooms, selected, scale, scaleDraft, showImg, recompute]);

  useEffect(() => { draw(); }, [draw]);

  // ---- zoom / pan ----
  const applyZoom = (factor) => {
    const v = view.current, z = Math.max(1, Math.min(8, v.zoom * factor));
    v.zoom = z; if (z === 1) { v.panx = 0; v.pany = 0; }
    draw();
  };
  const fitView = () => { view.current = { zoom: 1, panx: 0, pany: 0, rot: 0 }; draw(); };
  // wheel zooms; Shift+wheel rotates the view (desktop equivalent of a two-finger twist)
  const onWheel = (e) => {
    e.preventDefault();
    if (e.shiftKey) { view.current.rot = (view.current.rot || 0) + (e.deltaY < 0 ? -1 : 1) * 0.08; draw(); }
    else applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  // delete the selected box with the keyboard (desktop), ignoring text fields
  useEffect(() => {
    const onKey = (e) => {
      if (!selected) return;
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- pointer interaction ----
  const getXY = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { sx: cx, sy: cy, ...toPlan(cx, cy) };
  };

  const nearestWall = (px, py) => {
    let best = null;
    walls.forEach((w) => { const d = pointSeg(px, py, w.x1, w.y1, w.x2, w.y2); if (!best || d.dist < best.dist) best = { ...d, w }; });
    return best;
  };

  // snap a coordinate to the foot grid when drawing on the blank "Draw a new plan" canvas
  const snapGrid = (v) => (img?.blank && scale ? Math.round(v / scale.pixelsPerUnit) * scale.pixelsPerUnit : v);

  // snap a draft point to a nearby existing wall endpoint (so corners connect cleanly), else to the
  // foot grid. Returns { x, y, snapped }. excludeId skips a wall's own ends when dragging that wall.
  const SNAP_SCREEN_PX = 14;
  const snapEndpoint = (x, y, excludeId) => {
    let best = null, bd = SNAP_SCREEN_PX / (tf.current.s || 1);
    for (const w of walls) {
      if (w.id === excludeId) continue;
      for (const e of [[w.x1, w.y1], [w.x2, w.y2]]) {
        const d = Math.hypot(e[0] - x, e[1] - y);
        if (d < bd) { bd = d; best = { x: e[0], y: e[1] }; }
      }
    }
    return best ? { ...best, snapped: true } : { x: snapGrid(x), y: snapGrid(y), snapped: false };
  };

  // furniture + stairs as one selectable "box" list (stairs drawn first, so furniture is on top)
  const boxList = () => [...furniture.map((o) => ({ kind: "furn", o })), ...stairs.map((o) => ({ kind: "stair", o }))];
  const setBox = (kind, id, patch) => (kind === "furn"
    ? setFurniture((a) => a.map((o) => (o.id === id ? { ...o, ...patch } : o)))
    : setStairs((a) => a.map((o) => (o.id === id ? { ...o, ...patch } : o))));
  const delBox = (kind, id) => (kind === "furn"
    ? setFurniture((a) => a.filter((o) => o.id !== id))
    : setStairs((a) => a.filter((o) => o.id !== id)));
  // delete whatever is selected (wall / door / window / furniture / stairs)
  const deleteSelected = () => {
    if (!selected) return;
    onPushHistory?.();
    const { kind, id } = selected;
    if (kind === "wall") setWalls((a) => a.filter((w) => w.id !== id));
    else if (kind === "opening") setOpenings((a) => a.filter((o) => o.id !== id));
    else delBox(kind, id);
    setSelected(null);
  };
  // hit-test boxes: a resize handle of the selected box wins, else the topmost body under the point
  const hitBox = (px, py, sx, sy) => {
    const list = boxList();
    if (selected) {
      const f = list.find((b) => b.kind === selected.kind && b.o.id === selected.id);
      if (f) for (const cn of boxCorners(f.o)) { const p = toScreen(cn.x, cn.y); if (Math.hypot(p.x - sx, p.y - sy) < 11) return { ...f, corner: cn }; }
    }
    for (let i = list.length - 1; i >= 0; i--) if (boxInside(px, py, list[i].o)) return list[i];
    return null;
  };

  const onDown = (e) => {
    e.preventDefault();
    // two fingers → pinch-zoom + pan, not an edit
    if (e.touches && e.touches.length >= 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      gesture.current = {
        dist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1,
        mx: (t0.clientX + t1.clientX) / 2, my: (t0.clientY + t1.clientY) / 2,
        ang: Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX),
        zoom0: view.current.zoom, panx0: view.current.panx, pany0: view.current.pany, rot0: view.current.rot || 0,
      };
      drag.current = null;
      return;
    }
    const { sx, sy, x, y } = getXY(e);
    const hitR = 10 / tf.current.s;

    if (tool === "scale") { setScaleDraft({ x1: x, y1: y, x2: x, y2: y }); drag.current = { type: "scale" }; return; }
    if (tool === "wall") { const sp = snapEndpoint(x, y); drag.current = { type: "newwall", x1: sp.x, y1: sp.y, x2: sp.x, y2: sp.y, snapStart: sp.snapped, snapEnd: sp.snapped }; return; }
    if (tool === "door" || tool === "window") {
      const nw = nearestWall(x, y);
      if (nw && nw.dist < 40 / tf.current.s) {
        const um = scale ? (scale.unit === "ft" ? FT_TO_M : 1) : 1;
        const defW = scale ? ((tool === "door" ? DOOR_W_M : WIN_W_M) / um) * scale.pixelsPerUnit : 36;
        onPushHistory?.();
        setOpenings((o) => [...o, { id: nid(), x: nw.cx, y: nw.cy, w: defW, type: tool }]);
      }
      return;
    }
    if (tool === "erase") {
      // opening first
      const oh = openings.find((o) => { const p = toScreen(o.x, o.y); return Math.hypot(p.x - sx, p.y - sy) < 10; });
      if (oh) { onPushHistory?.(); setOpenings((o) => o.filter((q) => q.id !== oh.id)); return; }
      const bb = hitBox(x, y, sx, sy); // furniture / stairs
      if (bb) { onPushHistory?.(); delBox(bb.kind, bb.o.id); if (selected?.id === bb.o.id) setSelected(null); return; }
      const nw = nearestWall(x, y);
      if (nw && nw.dist < hitR * 1.5) { onPushHistory?.(); setWalls((w) => w.filter((q) => q.id !== nw.w.id)); }
      return;
    }
    // move tool — priority: resize handle of selection → wall endpoint → opening → box body (select+move)
    const bh = hitBox(x, y, sx, sy);
    if (bh?.corner) {
      const o = bh.o, d = ((o.deg || 0) * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d), hw = o.w / 2, hh = o.h / 2;
      const ox = -bh.corner.sx, oy = -bh.corner.sy; // opposite (fixed) corner
      const fixx = o.x + ox * hw * c - oy * hh * s, fixy = o.y + ox * hw * s + oy * hh * c;
      drag.current = { type: "boxresize", kind: bh.kind, id: o.id, fixx, fixy, ux: [c, s], uy: [-s, c] };
      return;
    }
    for (const w of walls) {
      for (const end of [1, 2]) {
        const ex = end === 1 ? w.x1 : w.x2, ey = end === 1 ? w.y1 : w.y2;
        const p = toScreen(ex, ey);
        if (Math.hypot(p.x - sx, p.y - sy) < 9) { setSelected({ kind: "wall", id: w.id }); drag.current = { type: "endpoint", id: w.id, end }; return; }
      }
    }
    const oh = openings.find((o) => { const p = toScreen(o.x, o.y); return Math.hypot(p.x - sx, p.y - sy) < 9; });
    if (oh) { setSelected({ kind: "opening", id: oh.id }); drag.current = { type: "opening", id: oh.id }; return; }
    if (bh) { setSelected({ kind: bh.kind, id: bh.o.id }); drag.current = { type: "boxmove", kind: bh.kind, id: bh.o.id, gx: bh.o.x - x, gy: bh.o.y - y }; return; }
    // tap on a wall line (away from its ends): select it and drag the whole wall
    const nw = nearestWall(x, y);
    if (nw && nw.dist < 12 / tf.current.s) {
      const w = nw.w;
      setSelected({ kind: "wall", id: w.id });
      drag.current = { type: "wallmove", id: w.id, gx1: w.x1 - x, gy1: w.y1 - y, gx2: w.x2 - x, gy2: w.y2 - y };
      return;
    }
    setSelected(null);
  };

  const onMove = (e) => {
    // two-finger pinch-zoom + pan + twist-to-rotate (map-like)
    if (e.touches && e.touches.length >= 2 && gesture.current) {
      const t0 = e.touches[0], t1 = e.touches[1], g = gesture.current;
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1;
      const mx = (t0.clientX + t1.clientX) / 2, my = (t0.clientY + t1.clientY) / 2;
      const ang = Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX);
      view.current.zoom = Math.max(1, Math.min(8, g.zoom0 * (dist / g.dist)));
      view.current.panx = g.panx0 + (mx - g.mx);
      view.current.pany = g.pany0 + (my - g.my);
      view.current.rot = g.rot0 + (ang - g.ang);
      draw();
      return;
    }
    if (!drag.current) return;
    const { x, y } = getXY(e);
    const d = drag.current;
    // snapshot once, on the first real move of a geometry-changing drag (not on a plain tap)
    if (!d.histPushed && ["endpoint", "wallmove", "opening", "boxmove", "boxresize"].includes(d.type)) { onPushHistory?.(); d.histPushed = true; }
    if (d.type === "endpoint") {
      const sp = snapEndpoint(x, y, d.id);   // connect to a nearby corner, else grid-snap
      // editing a wall counts as reviewing it → clear any "uncertain" flag (conf:1)
      setWalls((ws) => ws.map((w) => w.id === d.id ? (d.end === 1 ? { ...w, x1: sp.x, y1: sp.y, conf: 1 } : { ...w, x2: sp.x, y2: sp.y, conf: 1 }) : w));
    } else if (d.type === "wallmove") {
      setWalls((ws) => ws.map((w) => w.id === d.id ? { ...w, x1: x + d.gx1, y1: y + d.gy1, x2: x + d.gx2, y2: y + d.gy2, conf: 1 } : w));
    } else if (d.type === "newwall") {
      const sp = snapEndpoint(x, y);
      drag.current = { ...d, x2: sp.x, y2: sp.y, snapEnd: sp.snapped }; draw();
    } else if (d.type === "scale") {
      setScaleDraft((s) => s && { ...s, x2: x, y2: y });
    } else if (d.type === "opening") {
      const nw = nearestWall(x, y);
      setOpenings((o) => o.map((q) => q.id === d.id ? { ...q, x: nw ? nw.cx : x, y: nw ? nw.cy : y } : q));
    } else if (d.type === "boxmove") {
      setBox(d.kind, d.id, { x: x + d.gx, y: y + d.gy });
    } else if (d.type === "boxresize") {
      const Vx = x - d.fixx, Vy = y - d.fixy;                       // diagonal from the fixed corner to the pointer
      const w = Math.max(6, Math.abs(Vx * d.ux[0] + Vy * d.ux[1])); // project onto the box's own axes
      const h = Math.max(6, Math.abs(Vx * d.uy[0] + Vy * d.uy[1]));
      setBox(d.kind, d.id, { x: (d.fixx + x) / 2, y: (d.fixy + y) / 2, w, h });
    }
  };

  const onUp = () => {
    const d = drag.current;
    if (d?.type === "newwall") {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 6 / tf.current.s) {
        onPushHistory?.();
        setWalls((w) => [...w, { id: nid(), x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }]);
      }
    }
    if (d?.type === "scale") {
      const len = Math.hypot(scaleDraft.x2 - scaleDraft.x1, scaleDraft.y2 - scaleDraft.y1);
      if (len > 8) setScaleInput((s) => ({ ...s, _px: len }));
    }
    drag.current = null;
    gesture.current = null;
  };

  const applyScale = () => {
    const px = scaleInput._px;
    if (!px) return;
    let pixelsPerUnit = null, unit = "ft";
    if (scaleMode === "grid") {
      const sq = parseFloat(scaleInput.squares), fps = parseFloat(scaleInput.ftPerSq) || 1;
      if (sq > 0) pixelsPerUnit = px / (sq * fps); // px per foot
    } else {
      const len = parseFloat(scaleInput.len);
      if (len > 0) { pixelsPerUnit = px / len; unit = scaleInput.unit; }
    }
    if (pixelsPerUnit) {
      onPushHistory?.();
      setScale({ pixelsPerUnit, unit });
      setScaleDraft(null);
      setScaleInput((s) => ({ len: "", unit, squares: "", ftPerSq: s.ftPerSq }));
      setTool("move");
    }
  };

  // derived: building size if scale set
  let dims = null;
  if (scale && walls.length) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    walls.forEach((w) => { minx = Math.min(minx, w.x1, w.x2); maxx = Math.max(maxx, w.x1, w.x2); miny = Math.min(miny, w.y1, w.y2); maxy = Math.max(maxy, w.y1, w.y2); });
    // always report in feet-and-inches, converting from meters if the scale was set in m
    const toFeet = (vpx) => {
      const inUnit = vpx / scale.pixelsPerUnit;
      return scale.unit === "ft" ? inUnit : inUnit / FT_TO_M;
    };
    dims = `${ftIn(toFeet(maxx - minx))} × ${ftIn(toFeet(maxy - miny))}`;
  }

  const uncertainCount = walls.filter((w) => (w.conf ?? 1) < 0.6).length;

  const tools = [["move", "Move"], ["wall", "Add wall"], ["door", "Door"], ["window", "Window"], ["scale", "Set scale"], ["erase", "Erase"]];

  return (
    <div className="max-w-6xl mx-auto px-4 py-5">
      {error && <div className="mb-3 text-sm rounded-lg px-3 py-2" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fde68a" }}>{error}</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {tools.map(([k, label]) => (
          <button key={k} onClick={() => { setTool(k); setSelected(null); if (k === "scale") setScaleDraft(null); }}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{ background: tool === k ? "#6d5ae6" : "rgba(255,255,255,0.06)", border: "1px solid " + (tool === k ? "#8b78ff" : "rgba(255,255,255,0.12)"), color: tool === k ? "#fff" : "#cbd5e1" }}>
            {label}
          </button>
        ))}
        <button onClick={() => onUndo?.()} disabled={!canUndo} title="Undo last change (Ctrl/Cmd+Z)"
          className="px-2.5 py-1.5 rounded-lg text-sm flex items-center gap-1"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: canUndo ? "#cbd5e1" : "#64748b", opacity: canUndo ? 1 : 0.5, cursor: canUndo ? "pointer" : "default" }}>
          ↶ Undo
        </button>
        <div className="flex-1" />
        <button onClick={() => { setNameDraft(savedName || ""); setSaving(true); }} title="Save this plan to come back to later"
          className="px-2.5 py-1.5 rounded-lg text-sm text-slate-200 flex items-center gap-1" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>
          💾 Save
        </button>
        <button onClick={() => { onPushHistory?.(); onRotate(); }} title="Rotate the whole plan 90° (drag with two fingers to free-rotate the view)"
          className="px-2.5 py-1.5 rounded-lg text-sm text-slate-200 flex items-center gap-1" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>
          ↻ Rotate 90°
        </button>
        <label className="text-xs text-slate-400 flex items-center gap-1 select-none cursor-pointer">
          <input type="checkbox" checked={tidy} onChange={(e) => setTidy?.(e.target.checked)} /> tidy up the drawing
        </label>
        <label className="text-xs text-slate-400 flex items-center gap-1 select-none cursor-pointer">
          <input type="checkbox" checked={showImg} onChange={(e) => setShowImg(e.target.checked)} /> show drawing
        </label>
      </div>

      {saving && (
        <div className="mb-3 rounded-lg px-3 py-3 text-sm flex flex-wrap items-center gap-2" style={{ background: "rgba(124,99,255,0.1)", border: "1px solid rgba(124,99,255,0.3)" }}>
          <span className="text-slate-200">Name this plan:</span>
          <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSave?.(nameDraft); }}
            placeholder="e.g. Our house" className="px-2 py-1 rounded bg-black/30 border border-white/15 text-white" />
          <button onClick={() => onSave?.(nameDraft)} className="px-3 py-1 rounded text-white" style={{ background: "#6d5ae6" }}>Save</button>
          <button onClick={() => setSaving(false)} className="px-3 py-1 rounded text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>Close</button>
          {saveStatus && <span style={{ color: "#7CFFCB" }}>{saveStatus}</span>}
          <span className="w-full text-xs text-slate-400">Saved on this device — find it under “My plans” on the start screen.</span>
        </div>
      )}

      <div ref={wrapRef} className="rounded-xl overflow-hidden relative" style={{ border: "1px solid rgba(255,255,255,0.12)", touchAction: "none" }}>
        <canvas ref={canvasRef}
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
          onWheel={onWheel}
          style={{ display: "block", cursor: tool === "move" ? "grab" : "crosshair" }} />
        {/* zoom controls (pinch to zoom + two-finger drag to pan also work) */}
        <div className="absolute bottom-3 right-3 flex flex-col gap-1.5 select-none">
          {[["+", () => applyZoom(1.3)], ["⤢", fitView], ["−", () => applyZoom(1 / 1.3)]].map(([label, fn], i) => (
            <button key={i} onClick={fn} title={label === "⤢" ? "Fit to screen" : label === "+" ? "Zoom in" : "Zoom out"}
              className="w-9 h-9 rounded-lg text-lg font-medium text-white flex items-center justify-center"
              style={{ background: "rgba(20,16,46,0.85)", border: "1px solid rgba(255,255,255,0.18)" }}>{label}</button>
          ))}
        </div>
      </div>

      {/* control bar for whatever is selected — wall / door / window / furniture / stairs */}
      {(() => {
        if (!selected) return null;
        let sel = null;
        if (selected.kind === "wall") { const o = walls.find((w) => w.id === selected.id); sel = o && { kind: "wall", o }; }
        else if (selected.kind === "opening") { const o = openings.find((p) => p.id === selected.id); sel = o && { kind: "opening", o }; }
        else sel = boxList().find((b) => b.kind === selected.kind && b.o.id === selected.id);
        if (!sel) return null;
        const wallUnsure = sel.kind === "wall" && (sel.o.conf ?? 1) < 0.6;
        const label = sel.kind === "furn" ? "Furniture" : sel.kind === "stair" ? "Staircase"
          : sel.kind === "wall" ? (wallUnsure ? "Wall (unsure)" : "Wall") : (sel.o.type === "door" ? "Door" : "Window");
        const hint = sel.kind === "wall" ? (wallUnsure ? "we weren't sure about this one — fix it, or tap “looks right”" : "drag the wall to move it · drag an end to reshape")
          : sel.kind === "opening" ? "drag it along a wall to move it"
          : "drag the box to move · drag a corner to resize";
        return (
          <div className="mt-3 rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-3 text-sm" style={{ background: "rgba(124,255,203,0.08)", border: "1px solid rgba(124,255,203,0.3)" }}>
            <span style={{ color: "#7CFFCB" }}>{label} selected</span>
            {sel.kind === "furn" && (
              <label className="flex items-center gap-1.5 text-slate-300">this is a
                <select value={sel.o.type} onChange={(e) => { onPushHistory?.(); setBox("furn", sel.o.id, { type: e.target.value }); }}
                  className="px-2 py-1 rounded bg-black/30 border border-white/15 text-white">
                  {FURN_TYPE_LIST.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
                </select>
              </label>
            )}
            {sel.kind === "opening" && (
              <button onClick={() => { onPushHistory?.(); setOpenings((o) => o.map((q) => q.id === sel.o.id ? { ...q, type: q.type === "door" ? "window" : "door" } : q)); }}
                className="px-2.5 py-1 rounded text-xs text-white" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)" }}>
                make it a {sel.o.type === "door" ? "window" : "door"}
              </button>
            )}
            {wallUnsure && (
              <button onClick={() => { onPushHistory?.(); setWalls((a) => a.map((w) => w.id === sel.o.id ? { ...w, conf: 1 } : w)); }}
                className="px-2.5 py-1 rounded text-xs text-white" style={{ background: "rgba(124,255,203,0.18)", border: "1px solid rgba(124,255,203,0.45)" }}>
                looks right ✓
              </button>
            )}
            <span className="text-slate-400 text-xs">{hint}</span>
            <button onClick={deleteSelected}
              className="ml-auto px-3 py-1 rounded text-white text-xs font-medium" style={{ background: "#b4444e" }}>Delete</button>
          </div>
        );
      })()}

      {/* scale input panel */}
      {tool === "scale" && (
        <div className="mt-3 rounded-lg px-3 py-3 text-sm" style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)" }}>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-amber-200 mr-1">How do you want to set the real size?</span>
            {[["grid", "On grid paper"], ["wall", "I know a wall's length"]].map(([k, label]) => (
              <button key={k} onClick={() => setScaleMode(k)} className="px-2.5 py-1 rounded text-xs"
                style={{ background: scaleMode === k ? "#d97706" : "rgba(255,255,255,0.06)", border: "1px solid " + (scaleMode === k ? "#f59e0b" : "rgba(255,255,255,0.15)"), color: scaleMode === k ? "#fff" : "#fde68a" }}>
                {label}
              </button>
            ))}
          </div>
          {scaleMode === "grid" ? (
            <div className="flex flex-wrap items-center gap-2 text-amber-100">
              <span>Drag a line along the grid, then tell me how many squares it crossed:</span>
              <input type="number" placeholder="squares" value={scaleInput.squares}
                onChange={(e) => setScaleInput((s) => ({ ...s, squares: e.target.value }))}
                className="w-24 px-2 py-1 rounded bg-black/30 border border-white/15 text-white" />
              <span className="text-amber-200/80">squares,</span>
              <input type="number" value={scaleInput.ftPerSq}
                onChange={(e) => setScaleInput((s) => ({ ...s, ftPerSq: e.target.value }))}
                className="w-16 px-2 py-1 rounded bg-black/30 border border-white/15 text-white" />
              <span className="text-amber-200/80">ft per square</span>
              <button onClick={applyScale} disabled={!scaleInput._px || !(parseFloat(scaleInput.squares) > 0)}
                className="px-3 py-1 rounded text-white" style={{ background: scaleInput._px && parseFloat(scaleInput.squares) > 0 ? "#d97706" : "rgba(255,255,255,0.1)" }}>Set</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-amber-100">
              <span>Trace one wall you know the length of, then type how long it really is:</span>
              <input type="number" placeholder="length" value={scaleInput.len}
                onChange={(e) => setScaleInput((s) => ({ ...s, len: e.target.value }))}
                className="w-24 px-2 py-1 rounded bg-black/30 border border-white/15 text-white" />
              <select value={scaleInput.unit} onChange={(e) => setScaleInput((s) => ({ ...s, unit: e.target.value }))}
                className="px-2 py-1 rounded bg-black/30 border border-white/15 text-white">
                <option value="ft">feet</option><option value="m">meters</option>
              </select>
              <button onClick={applyScale} disabled={!scaleInput._px || !scaleInput.len}
                className="px-3 py-1 rounded text-white" style={{ background: scaleInput._px && scaleInput.len ? "#d97706" : "rgba(255,255,255,0.1)" }}>Set</button>
            </div>
          )}
          <div className="text-xs mt-2" style={{ color: scaleInput._px ? "#7CFFCB" : "rgba(253,230,138,0.6)" }}>
            {scaleInput._px ? `✓ line measured (${Math.round(scaleInput._px)}px) — now fill in the value and press Set` : "First drag a line on the plan above."}
          </div>
        </div>
      )}

      {/* status bar with a color legend so the dots/colors are self-explanatory */}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)" }}>
          {[
            { label: "walls", n: walls.length, color: "#c7b6ff", shape: "line" },
            { label: "doors", n: openings.filter((o) => o.type === "door").length, color: "#34d399", shape: "dot" },
            { label: "windows", n: openings.filter((o) => o.type === "window").length, color: "#38bdf8", shape: "dot" },
            { label: "furniture", n: furniture.length, color: "#5eead4", shape: "box" },
            ...(stairs.length ? [{ label: "stairs", n: stairs.length, color: "#fb923c", shape: "box" }] : []),
          ].map((it) => (
            <span key={it.label} className="flex items-center gap-1.5 text-slate-300">
              <span style={{
                display: "inline-block",
                width: it.shape === "line" ? 14 : 11, height: it.shape === "line" ? 4 : 11,
                borderRadius: it.shape === "dot" ? "50%" : it.shape === "line" ? 2 : 3,
                background: it.shape === "box" ? it.color + "44" : it.color,
                border: it.shape === "box" ? `1px solid ${it.color}` : "none",
              }} />
              <span><b className="text-white">{it.n}</b> {it.label}</span>
            </span>
          ))}
        </div>
        {scale ? (
          <span style={{ color: "#7CFFCB" }}>Real size set{dims ? ` · about ${dims}` : ""}</span>
        ) : (
          <span style={{ color: "#fbbf24" }}>Tap “Set scale” to tell us the real size (otherwise it's a guess)</span>
        )}
        {uncertainCount > 0 && (
          <span style={{ color: "#fbbf24" }}>⚠ {uncertainCount} wall{uncertainCount > 1 ? "s" : ""} {uncertainCount > 1 ? "look" : "looks"} uncertain (orange &amp; dashed) — tap to check</span>
        )}
        <label className="text-slate-400 flex items-center gap-2 ml-auto">ceiling
          <input type="range" min="7" max="11" step="0.5" value={ceiling} onChange={(e) => setCeiling(parseFloat(e.target.value))} />
          <span className="text-slate-300 w-12">{ftIn(ceiling)}</span>
        </label>
      </div>

      <div className="mt-5 flex gap-3">
        <button onClick={onBack} className="px-4 py-2 rounded-lg text-sm text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>← New plan</button>
        <button onClick={onWalk} disabled={walls.length < 3}
          className="px-5 py-2 rounded-lg text-sm font-semibold text-white ml-auto"
          style={{ background: walls.length < 3 ? "rgba(255,255,255,0.1)" : "#6d5ae6" }}>
          Build & walk it →
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">Tip: when adding or reshaping a wall, its end snaps onto a nearby corner (a ring shows the join). Pinch to zoom, twist two fingers to spin the view, and use ↶ Undo (or Ctrl/Cmd+Z) to take back the last change.</p>
    </div>
  );
}

// ================= 3D WALK =================
function Walk({ walls, openings, furniture = [], stairs = [], rooms = [], scale, ceiling, onExit }) {
  const mountRef = useRef(null);
  const miniRef = useRef(null);
  const [locked, setLocked] = useState(false);
  const touchMove = useRef({ x: 0, y: 0 }); // left stick → move (read in tick)
  const lookMove = useRef({ x: 0, y: 0 });  // right stick → look (read in tick)

  // Lock the page while walking: on mobile a look-drag would otherwise scroll/rubber-band the
  // whole page, sliding the fixed joystick out from under your thumb.
  useEffect(() => {
    const { body } = document, html = document.documentElement;
    const prevOverflow = body.style.overflow, prevOverscroll = html.style.overscrollBehavior;
    body.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    return () => { body.style.overflow = prevOverflow; html.style.overscrollBehavior = prevOverscroll; };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    const W = mount.clientWidth, H = mount.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(W, H);
    renderer.setClearColor(0x0c0a1f);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0c0a1f, 8, 60);
    const camera = new THREE.PerspectiveCamera(72, W / H, 0.05, 200);
    camera.rotation.order = "YXZ";
    camera.position.set(0, EYE_M, 0);

    // lights
    scene.add(new THREE.HemisphereLight(0xcdd6ff, 0x202036, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7); dir.position.set(6, 14, 4); scene.add(dir);
    scene.add(new THREE.AmbientLight(0x4a4570, 0.4));

    // --- build model in world meters, centered ---
    const mPerPx = (scale ? (scale.unit === "ft" ? FT_TO_M : 1) / scale.pixelsPerUnit : (12 / 1024)); // fallback ≈12m wide
    const ceilingM = ceiling * FT_TO_M; // ceiling prop is in feet; the 3D world is in meters
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    walls.forEach((w) => { minx = Math.min(minx, w.x1, w.x2); maxx = Math.max(maxx, w.x1, w.x2); miny = Math.min(miny, w.y1, w.y2); maxy = Math.max(maxy, w.y1, w.y2); });
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const W2 = (px, py) => [(px - cx) * mPerPx, (py - cy) * mPerPx]; // → [x, z]

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xece9f5, roughness: 0.95, metalness: 0 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.28, roughness: 0.1 });
    const collide = []; // {ax,az,bx,bz,ht}

    function box(x1, z1, x2, z2, yb, yt, t, mat) {
      const L = Math.hypot(x2 - x1, z2 - z1); if (L < 0.02) return;
      const g = new THREE.BoxGeometry(L, yt - yb, t);
      const m = new THREE.Mesh(g, mat);
      m.position.set((x1 + x2) / 2, (yb + yt) / 2, (z1 + z2) / 2);
      m.rotation.y = Math.atan2(-(z2 - z1), x2 - x1);
      scene.add(m);
    }

    // group openings to nearest wall (in px), with along-distance + half width in meters
    const owned = walls.map(() => []);
    openings.forEach((o) => {
      let bi = -1, bd = 1e9, bt = 0;
      walls.forEach((w, i) => { const d = pointSeg(o.x, o.y, w.x1, w.y1, w.x2, w.y2); if (d.dist < bd) { bd = d.dist; bi = i; bt = d.t; } });
      if (bi >= 0 && bd < 60) owned[bi].push({ t: bt, hw: (o.w * mPerPx) / 2, type: o.type });
    });

    walls.forEach((w, i) => {
      const [ax, az] = W2(w.x1, w.y1), [bx, bz] = W2(w.x2, w.y2);
      const L = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / (L || 1), uz = (bz - az) / (L || 1);
      const at = (d) => [ax + ux * d, az + uz * d];
      const ops = owned[i].map((o) => ({ s: Math.max(0, o.t * L - o.hw), e: Math.min(L, o.t * L + o.hw), type: o.type })).sort((p, q) => p.s - q.s);
      let cur = 0;
      const solid = (s, e) => {
        if (e - s < 0.03) return;
        const [sx, sz] = at(s), [ex, ez] = at(e);
        box(sx, sz, ex, ez, 0, ceilingM, WALL_T_M, wallMat);
        collide.push({ ax: sx, az: sz, bx: ex, bz: ez, ht: WALL_T_M / 2 + 0.02 });
      };
      ops.forEach((op) => {
        solid(cur, op.s);
        const [sx, sz] = at(op.s), [ex, ez] = at(op.e);
        if (op.type === "window") {
          box(sx, sz, ex, ez, 0, WIN_SILL_M, WALL_T_M, wallMat);        // sill
          box(sx, sz, ex, ez, WIN_TOP_M, ceilingM, WALL_T_M, wallMat); // header
          box(sx, sz, ex, ez, WIN_SILL_M, WIN_TOP_M, WALL_T_M * 0.4, glassMat);
          collide.push({ ax: sx, az: sz, bx: ex, bz: ez, ht: WALL_T_M / 2 + 0.02 }); // can't walk through glass
        } else {
          box(sx, sz, ex, ez, DOOR_TOP_M, ceilingM, WALL_T_M, wallMat); // lintel above door
          // door span left walkable (no collision)
        }
        cur = op.e;
      });
      solid(cur, L);
    });

    // floor + grid
    const fw = (maxx - minx) * mPerPx + 4, fh = (maxy - miny) * mPerPx + 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), new THREE.MeshStandardMaterial({ color: 0x2c2a44, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0; scene.add(floor);
    const grid = new THREE.GridHelper(Math.max(fw, fh), Math.round(Math.max(fw, fh)), 0x4a4570, 0x35324f);
    grid.position.y = 0.01; scene.add(grid);

    // --- furniture: simple blocks (visual only, walk-through) ---
    furniture.forEach((f) => {
      const spec = FURN_3D[f.type] || FURN_3D.other;
      const [wx, wz] = W2(f.x, f.y);
      const ww = Math.max(0.05, f.w * mPerPx), wd = Math.max(0.05, f.h * mPerPx);
      const m = new THREE.Mesh(new THREE.BoxGeometry(ww, spec.h, wd),
        new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.85 }));
      m.position.set(wx, spec.h / 2, wz);
      m.rotation.y = -((f.deg || 0) * Math.PI) / 180;
      scene.add(m);
    });

    // --- staircase: stepped block + footprint collision (non-walkable) ---
    stairs.forEach((s) => {
      const [wx, wz] = W2(s.x, s.y);
      const ww = Math.max(0.1, s.w * mPerPx), wd = Math.max(0.1, s.h * mPerPx);
      const a = -((s.deg || 0) * Math.PI) / 180;
      const grp = new THREE.Group(); grp.position.set(wx, 0, wz); grp.rotation.y = a;
      const N = 6, topH = Math.min(ceilingM * 0.95, 1.4), depth = wd / N;
      const stepMat = new THREE.MeshStandardMaterial({ color: 0xc8895a, roughness: 0.9 });
      for (let i = 0; i < N; i++) {
        const h = (topH * (i + 1)) / N;
        const m = new THREE.Mesh(new THREE.BoxGeometry(ww, h, depth), stepMat);
        m.position.set(0, h / 2, -wd / 2 + depth * (i + 0.5));
        grp.add(m);
      }
      scene.add(grp);
      const co = Math.cos(a), si = Math.sin(a), hw = ww / 2, hd = wd / 2;
      const corner = (lx, lz) => [wx + lx * co + lz * si, wz - lx * si + lz * co]; // Three.js Y-rotation
      const c1 = corner(-hw, -hd), c2 = corner(hw, -hd), c3 = corner(hw, hd), c4 = corner(-hw, hd);
      [[c1, c2], [c2, c3], [c3, c4], [c4, c1]].forEach(([p, q]) =>
        collide.push({ ax: p[0], az: p[1], bx: q[0], bz: q[1], ht: WALL_T_M / 2 + 0.02 }));
    });

    // --- floating room-name labels (always visible, for orientation) ---
    function makeLabel(text) {
      const fontPx = 48, pad = 22;
      const c = document.createElement("canvas");
      let ctx = c.getContext("2d");
      ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
      c.width = Math.ceil(ctx.measureText(text).width) + pad * 2; c.height = fontPx + pad * 2;
      ctx = c.getContext("2d");
      ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(12,10,31,0.6)"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#ece9f5"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, c.width / 2, c.height / 2);
      const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9, depthTest: false }));
      spr.scale.set(c.width * 0.0028, c.height * 0.0028, 1); spr.renderOrder = 10;
      return spr;
    }
    rooms.forEach((r) => {
      if (!r.name) return;
      const [wx, wz] = W2(r.x, r.y);
      const spr = makeLabel(r.name); spr.position.set(wx, 1.85, wz); scene.add(spr);
    });

    // (camera spawn is set after the collision resolver is defined)

    // ---- collision resolve (player radius) ----
    const R = 0.26;
    function resolve(px, pz) {
      let x = px, z = pz;
      for (let it = 0; it < 3; it++) {
        for (const s of collide) {
          const d = pointSeg(x, z, s.ax, s.az, s.bx, s.bz);
          const min = R + s.ht;
          if (d.dist < min) {
            const nx = (x - d.cx) / (d.dist || 1e-4), nz = (z - d.cy) / (d.dist || 1e-4);
            x = d.cx + nx * min; z = d.cy + nz * min;
          }
        }
      }
      return [x, z];
    }

    // spawn at footprint center, pushed out of any wall it lands on
    {
      const [sx0, sz0] = resolve(0, 0);
      camera.position.set(sx0, EYE_M, sz0);
    }

    // ---- input ----
    let yaw = camera.rotation.y, pitch = 0;
    const keys = {};
    const onKey = (v) => (e) => { keys[e.code] = v; };
    const kd = onKey(true), ku = onKey(false);
    window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);

    const onMouse = (e) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= e.movementX * 0.0024; pitch -= e.movementY * 0.0024;
      pitch = Math.max(-1.45, Math.min(1.45, pitch));
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    };
    document.addEventListener("mousemove", onMouse);
    const clickLock = () => renderer.domElement.requestPointerLock();
    renderer.domElement.addEventListener("click", clickLock);
    const onLockChange = () => setLocked(document.pointerLockElement === renderer.domElement);
    document.addEventListener("pointerlockchange", onLockChange);

    // Touch look is driven by the right joystick (lookMove ref), applied per-frame in tick().

    // ---- minimap ----
    const mini = miniRef.current;
    const mctx = mini?.getContext("2d");
    function minimap() {
      if (!mctx) return;
      const s = 150, pad = 10; mini.width = s; mini.height = s;
      mctx.clearRect(0, 0, s, s);
      mctx.fillStyle = "rgba(12,10,31,0.7)"; mctx.fillRect(0, 0, s, s);
      const spanX = (maxx - minx) * mPerPx, spanZ = (maxy - miny) * mPerPx;
      const sc = (s - pad * 2) / Math.max(spanX, spanZ, 1);
      const ox = s / 2, oz = s / 2;
      const P = (x, z) => [ox + x * sc, oz + z * sc];
      mctx.strokeStyle = "#8b78ff"; mctx.lineWidth = 1.5;
      collide.forEach((c) => { const [x1, y1] = P(c.ax, c.az), [x2, y2] = P(c.bx, c.bz); mctx.beginPath(); mctx.moveTo(x1, y1); mctx.lineTo(x2, y2); mctx.stroke(); });
      const [pxp, pzp] = P(camera.position.x, camera.position.z);
      mctx.fillStyle = "#7CFFCB"; mctx.beginPath(); mctx.arc(pxp, pzp, 3.5, 0, 7); mctx.fill();
      mctx.strokeStyle = "#7CFFCB"; mctx.beginPath(); mctx.moveTo(pxp, pzp);
      mctx.lineTo(pxp + Math.sin(yaw) * -10, pzp + Math.cos(yaw) * -10); mctx.stroke();
    }

    // ---- loop ----
    const up = new THREE.Vector3(0, 1, 0);
    const clock = new THREE.Clock();
    let raf;
    function tick() {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      const run = keys["ShiftLeft"] || keys["ShiftRight"];
      const speed = (run ? 5.2 : 2.6);
      const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      const mv = new THREE.Vector3();
      if (keys["KeyW"] || keys["ArrowUp"]) mv.add(fwd);
      if (keys["KeyS"] || keys["ArrowDown"]) mv.sub(fwd);
      if (keys["KeyD"] || keys["ArrowRight"]) mv.add(right);
      if (keys["KeyA"] || keys["ArrowLeft"]) mv.sub(right);
      mv.add(fwd.clone().multiplyScalar(-touchMove.current.y));
      mv.add(right.clone().multiplyScalar(touchMove.current.x));
      if (mv.lengthSq() > 0) {
        mv.normalize().multiplyScalar(speed * dt);
        const [nx, nz] = resolve(camera.position.x + mv.x, camera.position.z + mv.z);
        camera.position.x = nx; camera.position.z = nz;
      }
      camera.position.y = EYE_M;
      // right joystick → look: stick deflection sets the turn rate (like a console controller)
      const lk = lookMove.current;
      if (lk.x || lk.y) {
        yaw -= lk.x * 2.6 * dt;
        pitch = Math.max(-1.45, Math.min(1.45, pitch - lk.y * 1.9 * dt));
        camera.rotation.set(pitch, yaw, 0, "YXZ");
      }
      minimap();
      renderer.render(scene, camera);
    }
    tick();

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku);
      document.removeEventListener("mousemove", onMouse);
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", clickLock);
      if (document.pointerLockElement) document.exitPointerLock();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [walls, openings, furniture, stairs, rooms, scale, ceiling]);

  // ---- twin touch joysticks: left = move, right = look ----
  // One handler drives both. targetTouches scopes to the finger that landed on *this* stick,
  // so the two sticks work independently with two thumbs. The nub follows the thumb for feel.
  const moveBase = useRef(null), moveNub = useRef(null);
  const lookBase = useRef(null), lookNub = useRef(null);
  const NUB_TRAVEL = 36; // px the nub can slide from center
  const drive = (base, nub, out) => (e) => {
    const t = e.targetTouches[0];
    if (!t) { out.current = { x: 0, y: 0 }; if (nub.current) nub.current.style.transform = "translate(-50%,-50%)"; return; }
    const r = base.current.getBoundingClientRect();
    let dx = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    out.current = { x: dx, y: dy };
    if (nub.current) nub.current.style.transform = `translate(calc(-50% + ${dx * NUB_TRAVEL}px), calc(-50% + ${dy * NUB_TRAVEL}px))`;
  };
  const onMoveStick = drive(moveBase, moveNub, touchMove);
  const onLookStick = drive(lookBase, lookNub, lookMove);

  return (
    <div className="relative" style={{ height: "calc(100dvh - 53px)", touchAction: "none", overscrollBehavior: "none" }}>
      <div ref={mountRef} className="absolute inset-0" />
      {/* crosshair */}
      <div className="absolute left-1/2 top-1/2 pointer-events-none" style={{ transform: "translate(-50%,-50%)", width: 6, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.7)" }} />
      {/* minimap */}
      <canvas ref={miniRef} className="absolute top-3 right-3 rounded-lg" style={{ width: 150, height: 150, border: "1px solid rgba(255,255,255,0.15)" }} />
      {/* enter overlay */}
      {!locked && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-6">
          <div className="px-4 py-2.5 rounded-lg text-sm text-slate-200 text-center" style={{ background: "rgba(20,16,46,0.7)", border: "1px solid rgba(255,255,255,0.15)" }}>
            <span className="sm:hidden">Left stick to walk · right stick to look around</span>
            <span className="hidden sm:inline">Click to look around · <b>W A S D</b> move · <b>Shift</b> run · <b>Esc</b> release</span>
          </div>
        </div>
      )}
      {/* exit */}
      <button onClick={onExit} className="absolute top-3 left-3 px-3 py-1.5 rounded-lg text-sm text-slate-200"
        style={{ background: "rgba(20,16,46,0.8)", border: "1px solid rgba(255,255,255,0.15)" }}>← Edit plan</button>
      {/* twin touch joysticks (mobile): left = move, right = look */}
      <Stick label="move" baseRef={moveBase} nubRef={moveNub} onTouch={onMoveStick} side="left" />
      <Stick label="look" baseRef={lookBase} nubRef={lookNub} onTouch={onLookStick} side="right" />
    </div>
  );
}

// One on-screen joystick. Pinned above the home-indicator safe area; mobile only.
function Stick({ label, baseRef, nubRef, onTouch, side }) {
  return (
    <div ref={baseRef}
      onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={onTouch} onTouchCancel={onTouch}
      className={`absolute rounded-full sm:hidden ${side === "left" ? "left-6" : "right-6"}`}
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)", width: 120, height: 120, background: "rgba(124,99,255,0.12)", border: "1px solid rgba(124,99,255,0.4)", touchAction: "none" }}>
      <div ref={nubRef} className="absolute left-1/2 top-1/2 rounded-full" style={{ transform: "translate(-50%,-50%)", width: 46, height: 46, background: "rgba(124,99,255,0.55)" }} />
      <span className="absolute left-1/2 rounded text-[10px] uppercase tracking-wide text-slate-300 pointer-events-none" style={{ transform: "translateX(-50%)", bottom: -18 }}>{label}</span>
    </div>
  );
}
