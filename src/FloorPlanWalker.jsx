import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense, lazy } from "react";

// The 3D walk (and Three.js) loads only when someone presses "Build & walk it".
const Walk = lazy(() => import("./Walk.jsx"));
import { IS_TOUCH, CEILING_FT_DEFAULT, DOOR_W_M, FT_TO_M, FURN_TYPE_LIST, MAX_DIM, WIN_W_M, boxCorners, boxInside, ftIn, nid, pointSeg } from "./shared.js";
import { planFromModel, cleanSavedPlan, planFileBlob, readPlanFile, planToHash, planFromHash, fmtLen, pxToFeet, renderPlanImage, download, fileSafe } from "./planio.js";
import { traceWithClaude, TRACE_ERRORS, getKey, saveKey, forgetKey, keyIsRemembered, looksLikeKey } from "./vision.js";

/*  Blueprint → Walkable 3D  ·  end-to-end pipeline prototype
    Stages: upload → analyze (Claude vision) → calibrate + correct (2D editor) → walk (Three.js FPS)
    Coordinate spaces:
      - "plan px"  : the downscaled source-image pixel space (origin top-left, y down). All walls/openings stored here.
      - "world m"  : meters in Three.js (x right, z = plan-y, y up). mPerPx = unitMeters / pixelsPerUnit.
*/

// ---------- constants ----------

// ---------- saved plans (localStorage) ----------
// Client-only persistence so the user can save a plan, leave, and come back to walk it again.
// Lives in localStorage (no server, no new SaaS). Each entry: { id, name, savedAt, thumb, plan }.
const PLANS_KEY = "bw_plans";
// default real-world size (feet: width × depth) for things added with the "Add item" tool
const ITEM_FT = {
  bed: [5, 6.7], sofa: [7, 3], armchair: [3, 3], chair: [1.6, 1.6], table: [5, 3], coffee_table: [4, 2],
  desk: [4, 2], dresser: [5, 1.6], nightstand: [1.6, 1.4], wardrobe: [4, 2], bookshelf: [3, 1], tv: [4.5, 1],
  toilet: [1.6, 2.3], tub: [2.5, 5], shower: [3, 3], sink: [2, 1.6], counter: [6, 2], stove: [2.5, 2.2],
  fridge: [3, 2.5], rug: [6, 4], other: [2, 2], stairs: [3.5, 10],
};
const ITEM_TYPES = [...Object.keys(ITEM_FT).filter((k) => k !== "other"), "other"];
const prettyType = (t) => t.replace(/_/g, " ");

const FILE_ERROR = "We couldn't open that file. Try a JPG or PNG photo, or take a screenshot of the plan and use that.";

function loadPlans() {
  try {
    const v = JSON.parse(localStorage.getItem(PLANS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((e) => e && typeof e === "object" && e.id && e.plan) : [];
  } catch { return []; }
}
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
  const [errorRetry, setErrorRetry] = useState(false); // show "Try again" with the error
  const [savedPlans, setSavedPlans] = useState(loadPlans); // localStorage-backed "My plans"
  const [currentPlanId, setCurrentPlanId] = useState(null); // the saved entry we're editing, so Save overwrites it
  const [currentName, setCurrentName] = useState("");       // its name (prefilled into the Save box)
  const [saveStatus, setSaveStatus] = useState("");         // transient "Saved ✓" / quota message
  const [showIntro, setShowIntro] = useState(() => { try { return !localStorage.getItem("bw_intro_seen"); } catch { return false; } });
  // feet or meters for every length shown (the plan itself is stored in pixels + a scale)
  const [units, setUnitsState] = useState(() => { try { return localStorage.getItem("bw_units") === "m" ? "m" : "ft"; } catch { return "ft"; } });
  const setUnits = (u) => { setUnitsState(u); try { localStorage.setItem("bw_units", u); } catch {} };
  // in-app dialogs (instead of the browser's own prompt/confirm pop-ups)
  const [dialog, setDialog] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => setDialog({ ...opts, resolve })), []);
  const closeIntro = () => { try { localStorage.setItem("bw_intro_seen", "1"); } catch {} setShowIntro(false); };

  // squared walls used for the 3D build and the editor's "after" preview; raw walls stay editable
  const tidied = useMemo(() => (tidy ? tidyWalls(walls) : walls), [tidy, walls]);

  // ---- undo / redo history ----
  // Each entry snapshots the editable state BEFORE a discrete action. Every update is immutable
  // (new arrays/objects), so we can store references cheaply without deep-copying.
  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [dirty, setDirty] = useState(false); // unsaved changes since the last save/open
  const snapshot = () => ({ walls, openings, furniture, stairs, rooms, scale, ceiling });
  const restore = (s) => {
    setWalls(s.walls); setOpenings(s.openings); setFurniture(s.furniture);
    setStairs(s.stairs); setRooms(s.rooms); setScale(s.scale); setCeiling(s.ceiling);
  };
  const pushHistory = useCallback(() => {
    const h = historyRef.current;
    h.push(snapshot());
    if (h.length > 60) h.shift();
    redoRef.current = [];
    setCanUndo(true); setCanRedo(false); setDirty(true);
  }, [walls, openings, furniture, stairs, rooms, scale, ceiling]); // eslint-disable-line react-hooks/exhaustive-deps
  const undo = useCallback(() => {
    const s = historyRef.current.pop();
    if (!s) return;
    redoRef.current.push(snapshot());
    restore(s);
    setCanUndo(historyRef.current.length > 0); setCanRedo(true); setDirty(true);
  }, [walls, openings, furniture, stairs, rooms, scale, ceiling]); // eslint-disable-line react-hooks/exhaustive-deps
  const redo = useCallback(() => {
    const s = redoRef.current.pop();
    if (!s) return;
    historyRef.current.push(snapshot());
    restore(s);
    setCanUndo(true); setCanRedo(redoRef.current.length > 0); setDirty(true);
  }, [walls, openings, furniture, stairs, rooms, scale, ceiling]); // eslint-disable-line react-hooks/exhaustive-deps
  // a fresh or freshly opened plan: nothing to undo, nothing unsaved (refs + setters only, so stable)
  const resetHistory = () => { historyRef.current = []; redoRef.current = []; setCanUndo(false); setCanRedo(false); setDirty(false); };

  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo, in the editor (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e) => {
      if (stage !== "editor" || !(e.metaKey || e.ctrlKey)) return;
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, stage]);

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
        resetHistory();
      };
      im.onerror = () => { setError(FILE_ERROR); setErrorRetry(false); };
      im.src = e.target.result;
    };
    reader.onerror = () => { setError(FILE_ERROR); setErrorRetry(false); };
    if (!file || (file.type && !file.type.startsWith("image/"))) { setError(FILE_ERROR); setErrorRetry(false); return; }
    reader.readAsDataURL(file);
  }, []);

  // ---- vision extraction with the user's own Anthropic key ----
  // The browser calls Anthropic directly (src/vision.js). No server in the path, and each
  // trace is billed to the user's key. Returns the plan JSON contract { w, d, win, furn, stairs, scale, rooms }.
  const analyze = useCallback(async () => {
    if (!img?.url) return;                     // samples and drawn plans have no photo to trace
    const apiKey = getKey();
    if (!apiKey) { setError(TRACE_ERRORS.nokey.msg); setErrorRetry(false); return; }
    setStage("analyzing"); setError(null); setErrorRetry(false);
    const base64 = img.url.split(",")[1];
    try {
      const p = await traceWithClaude({ apiKey, base64, width: img.w, height: img.h });
      // every number is checked and clamped, and list sizes are capped (src/planio.js)
      const q = planFromModel(p, img.w, img.h);
      pushHistory();
      setWalls(q.walls); setOpenings(q.openings); setFurniture(q.furniture); setStairs(q.stairs); setRooms(q.rooms);
      if (q.scale) setScale(q.scale);
      const nw = q.walls;
      if (!nw.length) { setError(TRACE_ERRORS.unreadable.msg); setErrorRetry(true); }
      setStage("editor");
    } catch (err) {
      const code = TRACE_ERRORS[err?.code] ? err.code : "unreadable";
      setError(TRACE_ERRORS[code].msg); setErrorRetry(TRACE_ERRORS[code].retry);
      // Key and account problems get fixed on the photo screen; anything else lands in the
      // editor with the photo underneath, so the walls can still be traced by hand.
      setStage(["nokey", "badkey", "nocredit", "permission"].includes(code) ? "upload" : "editor");
    }
  }, [img, pushHistory]);

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
    resetHistory();
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
    resetHistory();
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
    setSavedPlans(next); setCurrentPlanId(id); setCurrentName(entry.name); setDirty(false);
  }, [img, walls, openings, furniture, stairs, rooms, scale, ceiling, tidy, currentPlanId, savedPlans]);

  // Load a plan into the editor (or straight into the walk). Every plan from storage, a file or a
  // share link goes through cleanSavedPlan, which re-ids every piece (so ids saved in an earlier
  // session can't collide) and checks every number.
  const loadPlan = useCallback((raw, { id = null, name = "", walk = false } = {}) => {
    const p = cleanSavedPlan(raw);
    if (!p) { setError("That plan couldn't be opened. It may be damaged."); setErrorRetry(false); return false; }
    setImg(p.img);
    setWalls(p.walls); setOpenings(p.openings); setFurniture(p.furniture); setStairs(p.stairs); setRooms(p.rooms);
    setScale(p.scale); setCeiling(p.ceiling); setTidy(p.tidy);
    setCurrentPlanId(id); setCurrentName(name); setSaveStatus(""); setError(null);
    resetHistory();
    setStage(walk && p.walls.length >= 3 ? "walk" : "editor");
    return true;
  }, []);
  const openPlan = useCallback((entry, walk) => loadPlan(entry.plan, { id: entry.id, name: entry.name, walk }), [loadPlan]);

  const renamePlan = useCallback((id, name) => {
    const clean = (name || "").trim(); if (!clean) return;
    setSavedPlans((list) => { const next = list.map((p) => p.id === id ? { ...p, name: clean } : p); tryPersist(next); return next; });
    setCurrentName((cn) => (id === currentPlanId ? clean : cn));
  }, [currentPlanId]);

  const deletePlan = useCallback((id) => {
    setSavedPlans((list) => { const next = list.filter((p) => p.id !== id); tryPersist(next); return next; });
    if (id === currentPlanId) { setCurrentPlanId(null); setCurrentName(""); }
  }, [currentPlanId]);

  // ---- files, pictures and share links ----
  const [notice, setNotice] = useState(null);   // friendly one-line status for the editor (green)
  const currentPlan = () => ({ img, walls, openings, furniture, stairs, rooms, scale, ceiling, tidy });
  const planName = () => currentName || "My plan";
  const exportFile = () => { download(planFileBlob(currentPlan(), planName()), `${fileSafe(planName())}.blueprint.json`); setNotice("Plan file downloaded. Open it later from the start screen, on any device."); };
  const exportImage = () => {
    const c = renderPlanImage({ ...currentPlan(), walls: tidied }, { units, title: planName() });
    c.toBlob((b) => { if (b) { download(b, `${fileSafe(planName())}-plan.png`); setNotice("Picture of the plan downloaded."); } }, "image/png");
  };
  const shareLink = async () => {
    try {
      const hash = await planToHash({ ...currentPlan(), walls: tidy ? tidied : walls }, planName());
      const url = `${location.origin}${location.pathname}#${hash}`;
      if (url.length > 60000) { setNotice("This plan is too big for a link. Download the plan file and send that instead."); return; }
      await navigator.clipboard.writeText(url);
      setNotice("Link copied. Anyone with the link can see this layout (not your photo).");
    } catch { setNotice("Couldn't copy the link here. Download the plan file and send that instead."); }
  };
  const openFile = async (file) => {
    try { const { name, plan } = await readPlanFile(file); loadPlan(plan, { name }); setNotice(`Opened “${name}”. Save it to keep it in My plans.`); }
    catch (e) { setError(e.message); setErrorRetry(false); }
  };
  // a shared link (#plan=...) opens straight into the editor, then the address is tidied up
  useEffect(() => {
    if (!location.hash.startsWith("#plan=")) return;
    planFromHash(location.hash).then((res) => {
      history.replaceState(null, "", location.pathname + location.search);
      if (res && loadPlan(res.plan, { name: res.name })) setNotice(`Opened a shared plan, “${res.name}”. Save it to keep it.`);
      else { setError("That share link is damaged or incomplete."); setErrorRetry(false); }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
      className="w-full min-h-screen text-slate-100"
    >
      <div className="min-h-screen w-full" style={{ background: "radial-gradient(1200px 600px at 70% -10%, #2a1f5e 0%, #15122e 45%, #0c0a1f 100%)" }}>
        {showIntro && <Welcome onClose={closeIntro} />}
        {dialog && <Dialog {...dialog} onClose={(v) => { dialog.resolve(v); setDialog(null); }} />}
        <Header stage={stage} onHelp={() => setShowIntro(true)} />
        {stage === "upload" && (
          <Upload img={img} onFile={ingest} onAnalyze={analyze} onSample={loadSample} onBlank={startBlank}
            onReset={async () => {
              if (dirty && !(await ask({ title: "Start over?", body: "This plan has changes that aren't saved. Save it first if you want to keep it.", confirmLabel: "Start over", danger: true }))) return;
              setImg(null); setError(null); resetHistory();
            }}
            onSkip={() => { setError(null); setStage("editor"); }}
            onKeyChange={() => setError(null)}
            error={error}
            savedPlans={savedPlans} onOpenPlan={openPlan} onRenamePlan={renamePlan} onDeletePlan={deletePlan} ask={ask} onOpenFile={openFile} />
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
            error={error} onRetry={errorRetry && img?.url ? analyze : null} onRotate={rotatePlan}
            savedName={currentName} onSave={savePlan} saveStatus={saveStatus}
            onUndo={undo} canUndo={canUndo} onRedo={redo} canRedo={canRedo} onPushHistory={pushHistory}
            units={units} setUnits={setUnits} ask={ask}
            notice={notice} onNotice={setNotice} onExportFile={exportFile} onExportImage={exportImage} onShareLink={shareLink}
            onWalk={() => setStage("walk")}
            onBack={() => { setError(null); setNotice(null); setStage("upload"); }}
          />
        )}
        {stage === "walk" && (
          <Suspense fallback={<div className="py-24 text-center text-slate-300">Building your space…</div>}>
            <Walk walls={tidied} openings={openings} furniture={furniture} stairs={stairs} rooms={rooms} scale={scale} ceiling={ceiling} onExit={() => setStage("editor")} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ---------- in-app dialog (confirm, or ask for a short text) ----------
// onClose(value): confirm -> true (or the typed text), cancel -> false/null.
function Dialog({ title, body, input, confirmLabel = "OK", cancelLabel = "Cancel", danger = false, onClose }) {
  const [text, setText] = useState(input ?? "");
  const okRef = useRef(null), inRef = useRef(null);
  const asksText = input !== undefined;
  const ok = () => onClose(asksText ? (text.trim() || null) : true);
  useEffect(() => {
    (asksText ? inRef.current : okRef.current)?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(asksText ? null : false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-5" style={{ background: "rgba(8,6,20,0.72)" }} onClick={() => onClose(asksText ? null : false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="bw-dialog-title" className="w-full max-w-sm rounded-2xl p-5"
        style={{ background: "#15122e", border: "1px solid rgba(255,255,255,0.12)" }} onClick={(e) => e.stopPropagation()}>
        <h2 id="bw-dialog-title" className="text-base font-semibold text-slate-100 mb-1.5">{title}</h2>
        {body && <p className="text-sm text-slate-300 mb-4">{body}</p>}
        {asksText && (
          <input ref={inRef} value={text} onChange={(e) => setText(e.target.value)} maxLength={40}
            onKeyDown={(e) => { if (e.key === "Enter") ok(); }} aria-label={title}
            className="w-full px-3 py-2.5 mb-4 rounded-lg text-sm text-slate-100 outline-none" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)" }} />
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={() => onClose(asksText ? null : false)} className="min-h-11 px-4 rounded-lg text-sm text-slate-200" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>{cancelLabel}</button>
          <button ref={okRef} onClick={ok} className="min-h-11 px-4 rounded-lg text-sm font-semibold text-white" style={{ background: danger ? "#b4444e" : "#6d5ae6" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- first-open tutorial ----------
function Welcome({ onClose }) {
  const steps = [
    ["📷", "Add your plan", "Snap a photo of a floor plan (a sketch on paper is perfect), open a plan file, or start a blank grid and draw one."],
    ["✨", "Trace it", "Claude finds the walls, doors, windows, and furniture, using your own Anthropic key. No key? Trace it by hand over your photo."],
    ["✏️", "Fix it up", "Tap any piece to move, resize, rename or delete it. Set the real size so lengths are right."],
    ["🚶", "Walk it", "Step inside and walk around, or see the whole place from above in Dollhouse view."],
  ];
  const tools = [
    ["Add wall", "drag from corner to corner; ends snap together"],
    ["Door / Window", "tap on a wall"],
    ["Add item", "pick furniture or stairs, then tap where it goes"],
    ["Room name", "tap where a room's name should go"],
    ["Set real size", "tell us one real length, or how big the grid squares are"],
    ["Share & download", "a link, a picture, or a plan file to open anywhere"],
  ];
  const okRef = useRef(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(8,6,20,0.72)" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="bw-help-title" className="w-full max-w-md rounded-2xl p-6 overflow-y-auto" style={{ maxHeight: "calc(100dvh - 2rem)", background: "#15122e", border: "1px solid rgba(255,255,255,0.12)" }} onClick={(e) => e.stopPropagation()}>
        <h2 id="bw-help-title" className="text-xl font-semibold mb-1" style={{ color: "#c7b6ff" }}>Welcome 👋</h2>
        <p className="text-slate-300 text-sm mb-5">Turn a floor plan into a space you can walk through, in four steps:</p>
        <ol className="flex flex-col gap-3.5 mb-5">
          {steps.map(([icon, title, body], i) => (
            <li key={i} className="flex gap-3">
              <div className="text-xl leading-none mt-0.5" aria-hidden="true">{icon}</div>
              <div>
                <div className="text-slate-100 font-medium text-sm">{i + 1}. {title}</div>
                <div className="text-slate-300 text-xs leading-relaxed">{body}</div>
              </div>
            </li>
          ))}
        </ol>
        <h3 className="text-sm font-medium text-slate-100 mb-1.5">In the editor</h3>
        <ul className="mb-5 text-xs text-slate-300 leading-relaxed">
          {tools.map(([k, v]) => <li key={k}><b className="text-slate-100 font-medium">{k}</b>: {v}</li>)}
        </ul>
        <h3 className="text-sm font-medium text-slate-100 mb-1.5">Your privacy</h3>
        <ul className="mb-6 text-xs text-slate-300 leading-relaxed list-disc pl-4">
          <li>A photo you trace goes straight from your device to Anthropic (the makers of Claude), on your own key. It never touches our server.</li>
          <li>Your key stays on this device, and only for this visit unless you tick “Remember”.</li>
          <li>Plans you save stay in this browser. Share links carry the layout, never your photo.</li>
          <li>Drawing by hand, the sample, and the 3D walk use no AI and send nothing anywhere.</li>
        </ul>
        <button ref={okRef} onClick={onClose} className="w-full min-h-11 rounded-lg text-sm font-semibold text-white" style={{ background: "#6d5ae6" }}>Get started</button>
      </div>
    </div>
  );
}

// ---------- header ----------
function Header({ stage, onHelp }) {
  const steps = [["upload", "Add plan"], ["analyzing", "Reading"], ["editor", "Fix it up"], ["walk", "Walk it"]];
  const idx = { upload: 0, analyzing: 1, editor: 2, walk: 3 }[stage];
  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2.5 border-b border-white/10 backdrop-blur"
      style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="flex items-baseline gap-3 min-w-0">
        <span className="text-base font-semibold tracking-tight whitespace-nowrap" style={{ color: "#c7b6ff" }}>Blueprint Walker</span>
        <span className="text-xs text-slate-400 hidden lg:inline">your floor plan, as a space you can walk through</span>
      </div>
      <div className="flex items-center gap-2">
        {/* phones: just the current step */}
        <span className="md:hidden text-xs text-slate-300 whitespace-nowrap">Step {idx + 1} of 4 · {steps[idx][1]}</span>
        {/* wider screens: all four steps */}
        <ol className="hidden md:flex items-center gap-2" aria-label="Steps">
          {steps.map(([k, label], i) => (
            <li key={k} className="flex items-center gap-2" aria-current={i === idx ? "step" : undefined}>
              <span className={"text-[11px] px-2 py-1 rounded-full whitespace-nowrap " + (i <= idx ? "text-white" : "text-slate-400")}
                style={{ background: i <= idx ? "rgba(124,99,255,0.25)" : "transparent", border: "1px solid " + (i <= idx ? "rgba(124,99,255,0.5)" : "rgba(255,255,255,0.08)") }}>
                {i + 1}. {label}
              </span>
              {i < steps.length - 1 && <span className="text-slate-400 text-xs" aria-hidden="true">→</span>}
            </li>
          ))}
        </ol>
        <button onClick={onHelp} title="How it works" aria-label="How it works"
          className="ml-1 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 rounded-full text-sm text-slate-200 flex items-center justify-center shrink-0"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)" }}>?</button>
      </div>
    </div>
  );
}

// ---------- upload ----------
function Upload({ img, onFile, onAnalyze, onSample, onBlank, onReset, onSkip, onKeyChange, error, ask, onOpenFile, savedPlans = [], onOpenPlan, onRenamePlan, onDeletePlan }) {
  const fileRef = useRef(null), camRef = useRef(null), planFileRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [hasKey, setHasKey] = useState(() => !!getKey());
  const drop = (e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); };

  return (
    <div className="max-w-3xl mx-auto px-5 py-10">
      {!img ? (
        <>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-2">Turn a drawing into a space you can walk through.</h1>
          <p className="text-slate-400 mb-7 text-sm">Take a photo of a floor plan — even a rough sketch on paper. We'll trace the walls for you, you fix anything that looks off, tell us the real size, then walk through your space.</p>
          {error && <div role="alert" className="mb-5 text-sm rounded-lg px-3 py-2" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fde68a" }}>{error}</div>}
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={drop}
            className="rounded-2xl p-10 text-center transition"
            style={{ border: "1.5px dashed " + (drag ? "#7c63ff" : "rgba(255,255,255,0.15)"), background: drag ? "rgba(124,99,255,0.08)" : "rgba(255,255,255,0.02)" }}
          >
            <div className="text-slate-300 mb-4 text-sm">{IS_TOUCH ? "Add your plan:" : "Drag a plan here, or"}</div>
            <div className="flex flex-wrap gap-3 justify-center">
              <button onClick={() => fileRef.current?.click()} className="pointer-coarse:min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: "#6d5ae6" }}>Choose file</button>
              {IS_TOUCH && <button onClick={() => camRef.current?.click()} className="pointer-coarse:min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}>Take a photo</button>}
              <button onClick={onBlank} className="pointer-coarse:min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: "rgba(124,255,203,0.14)", border: "1px solid rgba(124,255,203,0.4)" }}>Draw a new plan</button>
              <button onClick={onSample} className="pointer-coarse:min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-slate-200" style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)" }}>Try a sample</button>
              <button onClick={() => planFileRef.current?.click()} className="pointer-coarse:min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-slate-200" style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)" }}>Open a plan file</button>
            </div>
            <div className="text-slate-400 text-xs mt-4">“Draw a new plan” gives you a blank grid where 1 square = 1 foot — no photo needed.</div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <input ref={planFileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onOpenFile?.(f); }} />
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
                        <div className="text-[11px] text-slate-400">{new Date(p.savedAt).toLocaleDateString()}{p.photoDropped ? " · no photo" : ""}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button onClick={() => onOpenPlan?.(p, false)} className="flex-1 min-h-9 pointer-coarse:min-h-11 px-2 py-1 rounded text-xs font-medium text-white" style={{ background: "#6d5ae6" }}>Open</button>
                        <button onClick={() => onOpenPlan?.(p, true)} title="Walk it now" className="min-h-9 pointer-coarse:min-h-11 px-2 py-1 rounded text-xs text-white" style={{ background: "rgba(124,255,203,0.16)", border: "1px solid rgba(124,255,203,0.4)" }}>Walk</button>
                        <button onClick={async () => { const n = await ask({ title: "Rename this plan", input: p.name, confirmLabel: "Rename" }); if (n) onRenamePlan?.(p.id, n); }} title="Rename" aria-label="Rename plan" className="min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-2 py-1 rounded text-xs text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>✎</button>
                        <button onClick={async () => { if (await ask({ title: `Delete “${p.name}”?`, body: "This can't be undone.", confirmLabel: "Delete", danger: true })) onDeletePlan?.(p.id); }} title="Delete" aria-label="Delete plan" className="min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-2 py-1 rounded text-xs" style={{ background: "rgba(180,68,78,0.18)", border: "1px solid rgba(180,68,78,0.4)", color: "#ffb4ba" }}>🗑</button>
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
          {img.url ? (
            <>
              <h2 className="text-lg font-medium mb-4">Looks good — ready when you are.</h2>
              <div className="inline-block rounded-xl overflow-hidden mb-5" style={{ border: "1px solid rgba(255,255,255,0.12)", maxWidth: "100%" }}>
                <img src={img.url} alt="floor plan" style={{ maxHeight: 360, maxWidth: "100%", display: "block" }} />
              </div>
              {error && <div role="alert" className="max-w-xl mx-auto mb-4 text-sm rounded-lg px-3 py-2 text-left" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fde68a" }}>{error}</div>}
              <KeyBox onChange={(v) => { setHasKey(v); onKeyChange?.(); }} />
              <div className="flex flex-wrap gap-3 justify-center mt-5">
                <button onClick={onAnalyze} disabled={!hasKey} className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#6d5ae6" }}>Trace my plan →</button>
                <button onClick={onSkip} className="px-4 py-2.5 rounded-lg text-sm text-white" style={{ background: "rgba(124,255,203,0.14)", border: "1px solid rgba(124,255,203,0.4)" }}>Trace it by hand</button>
                <button onClick={onReset} className="px-4 py-2.5 rounded-lg text-sm text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>Use a different image</button>
              </div>
              <p className="text-slate-400 text-xs mt-3">“Trace it by hand” puts your photo under the grid so you can draw the walls over it. No key needed.</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-medium mb-4">You have a plan open.</h2>
              <div className="flex flex-wrap gap-3 justify-center">
                <button onClick={onSkip} className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white" style={{ background: "#6d5ae6" }}>Keep editing →</button>
                <button onClick={onReset} className="px-4 py-2.5 rounded-lg text-sm text-slate-300" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>Start over</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- the user's own Anthropic key ----------
// Tracing runs on the user's own Anthropic account. The key stays on this device
// (src/vision.js) and is only ever sent to api.anthropic.com.
function KeyBox({ onChange }) {
  const [key, setKeyState] = useState(getKey);
  const [remembered, setRemembered] = useState(keyIsRemembered);
  const [editing, setEditing] = useState(() => !getKey());
  const [draft, setDraft] = useState("");
  const [remember, setRemember] = useState(false);
  const [warn, setWarn] = useState("");

  const save = () => {
    if (!looksLikeKey(draft)) { setWarn("That doesn't look like an Anthropic API key. Keys start with “sk-ant-”."); return; }
    saveKey(draft, remember);
    setKeyState(draft.trim()); setRemembered(remember); setDraft(""); setWarn(""); setEditing(false);
    onChange?.(true);
  };
  const forget = () => {
    forgetKey(); setKeyState(""); setRemembered(false); setEditing(true);
    onChange?.(false);
  };

  return (
    <div className="max-w-xl mx-auto text-left rounded-xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.12)" }}>
      <div className="text-sm font-medium text-slate-100 mb-1">Trace it automatically with Claude</div>
      <p className="text-xs text-slate-400 leading-relaxed mb-3">
        Tracing uses Claude, Anthropic's AI, on <strong className="text-slate-200">your own Anthropic account</strong>. A trace usually costs a cent or two.
        Your photo and key go straight from this device to Anthropic. They never touch our server, and we never see them.
      </p>
      {key && !editing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-200">Key saved <span className="font-mono text-slate-400">····{key.slice(-4)}</span></span>
          <span className="text-xs text-slate-400">({remembered ? "remembered on this device" : "for this visit only"})</span>
          <span className="flex-1" />
          <button onClick={() => setEditing(true)} className="px-3 py-1.5 rounded-lg text-xs text-slate-200" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>Change</button>
          <button onClick={forget} className="px-3 py-1.5 rounded-lg text-xs" style={{ background: "rgba(180,68,78,0.18)", border: "1px solid rgba(180,68,78,0.4)", color: "#ffb4ba" }}>Forget key</button>
        </div>
      ) : (
        <div>
          <label htmlFor="bw-key" className="block text-xs text-slate-300 mb-1">Your Anthropic API key</label>
          <div className="flex gap-2">
            <input id="bw-key" type="password" value={draft} onChange={(e) => { setDraft(e.target.value); setWarn(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm text-slate-100 outline-none"
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.15)" }} />
            <button onClick={save} disabled={!draft.trim()} className="pointer-coarse:min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40" style={{ background: "#6d5ae6" }}>Save</button>
          </div>
          {warn && <div role="alert" className="text-xs mt-1.5" style={{ color: "#fde68a" }}>{warn}</div>}
          <label className="flex items-center gap-2 text-xs text-slate-300 mt-2.5">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="w-4 h-4" />
            Remember on this device (leave unticked on a shared computer)
          </label>
          <p className="text-xs text-slate-400 mt-2.5">
            No key yet? Make one at{" "}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "#c7b6ff" }}>console.anthropic.com</a>
            {" "}(you'll need to add a little credit). Or skip it: “Trace it by hand” is free.
          </p>
          {key && <button onClick={() => { setEditing(false); setDraft(""); setWarn(""); }} className="text-xs text-slate-400 underline mt-2">Keep my saved key</button>}
        </div>
      )}
    </div>
  );
}

function Analyzing() {
  return (
    <div role="status" aria-live="polite" className="max-w-xl mx-auto px-5 py-24 text-center">
      <div aria-hidden="true" className="inline-block w-10 h-10 rounded-full mb-5 motion-safe:animate-spin" style={{ border: "3px solid rgba(124,99,255,0.25)", borderTopColor: "#a48bff" }} />
      <p className="text-slate-300">Reading your plan…</p>
      <p className="text-slate-400 text-xs mt-2">Finding the walls, doors, and windows — you'll get to fix anything next.</p>
    </div>
  );
}

// ================= 2D EDITOR =================
function Editor({ img, walls, setWalls, tidied = [], tidy = false, setTidy, openings, setOpenings, furniture = [], setFurniture, stairs = [], setStairs, rooms = [], setRooms, scale, setScale, ceiling, setCeiling, error, onRetry, onRotate, savedName = "", onSave, saveStatus = "", onUndo, canUndo = false, onRedo, canRedo = false, onPushHistory, units = "ft", setUnits, ask, notice, onNotice, onExportFile, onExportImage, onShareLink, onWalk, onBack }) {
  const canvasRef = useRef(null);
  const HIT = IS_TOUCH ? 2 : 1;                       // fingers are bigger than mouse pointers
  const [saving, setSaving] = useState(false);          // inline "name this plan" panel open?
  const [nameDraft, setNameDraft] = useState(savedName); // editable name in the Save panel
  const wrapRef = useRef(null);
  const tf = useRef({ s: 1, ox: 0, oy: 0, cos: 1, sin: 0 }); // plan→screen similarity transform (fit × zoom/pan/rotate)
  const fit = useRef({ s: 1, ox: 0, oy: 0 });      // base "whole plan fits" transform
  const view = useRef({ zoom: 1, panx: 0, pany: 0, rot: 0 }); // user zoom (≥1) + pan + free rotation, on top of the fit
  const drag = useRef(null);                       // active interaction
  const gesture = useRef(null);                    // active two-finger pinch/pan
  const [tool, setTool] = useState("move");
  const [addType, setAddType] = useState("bed");          // what the "Add item" tool places
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
    const pills = roomPills();
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
      // the type name, unless a room name already sits on this spot (they used to overlap)
      if (!pills.some((q) => Math.abs(c.x - q.x) < q.hw + 18 && Math.abs(c.y - q.y) < q.hh + 8)) {
        x.fillStyle = "rgba(190,255,242,0.92)"; x.font = "10px ui-sans-serif, system-ui, sans-serif";
        x.textAlign = "center"; x.textBaseline = "middle";
        x.fillText(prettyType(f.type), c.x, c.y);
      }
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
    // room name labels (on top), with a soft pill behind for legibility; ring the selected one
    pills.forEach((q) => {
      const isSel = selected?.kind === "room" && selected.id === q.r.id;
      x.font = labelFont; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillStyle = isSel ? "rgba(124,255,203,0.22)" : "rgba(12,10,31,0.55)";
      x.beginPath(); x.rect(q.x - q.hw, q.y - q.hh, q.hw * 2, q.hh * 2); x.fill();
      if (isSel) { x.strokeStyle = "#7CFFCB"; x.lineWidth = 2; x.strokeRect(q.x - q.hw, q.y - q.hh, q.hw * 2, q.hh * 2); }
      x.fillStyle = "#ece9f5"; x.fillText(q.r.name, q.x, q.y);
    });
    // length of the selected wall, and of a wall being drawn
    const lengthTag = (ax, ay, bx, by, text) => {
      if (!text) return;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, L = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / L * 16, ny = (bx - ax) / L * 16;
      x.font = "600 11px ui-sans-serif, system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
      const tw = x.measureText(text).width;
      x.fillStyle = "rgba(12,10,31,0.85)"; x.fillRect(mx + nx - tw / 2 - 5, my + ny - 9, tw + 10, 18);
      x.fillStyle = "#7CFFCB"; x.fillText(text, mx + nx, my + ny);
    };
    if (selWallId) {
      const w = (overlay ? tidied : walls).find((q) => q.id === selWallId);
      if (w) { const a = toScreen(w.x1, w.y1), b = toScreen(w.x2, w.y2); lengthTag(a.x, a.y, b.x, b.y, lenLabel(Math.hypot(w.x2 - w.x1, w.y2 - w.y1))); }
    }
    if (drag.current?.type === "newwall") {
      const dc = drag.current, a = toScreen(dc.x1, dc.y1), b = toScreen(dc.x2, dc.y2);
      lengthTag(a.x, a.y, b.x, b.y, lenLabel(Math.hypot(dc.x2 - dc.x1, dc.y2 - dc.y1)));
    }
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
  }, [img, size, walls, tidied, tidy, openings, furniture, stairs, rooms, selected, scale, scaleDraft, showImg, recompute, units]);

  useEffect(() => { draw(); }, [draw]);

  // ---- zoom / pan ----
  const applyZoom = (factor) => {
    const v = view.current, z = Math.max(1, Math.min(8, v.zoom * factor));
    v.zoom = z; if (z === 1) { v.panx = 0; v.pany = 0; }
    draw();
  };
  const fitView = () => { view.current = { zoom: 1, panx: 0, pany: 0, rot: 0 }; draw(); };
  // Ctrl/Cmd + scroll zooms (a trackpad pinch arrives as Ctrl + scroll); Shift + scroll turns the view.
  // A plain scroll scrolls the page, so the buttons under the plan stay reachable on a laptop.
  // Native listener: React's onWheel is passive, so it can't stop the page from scrolling.
  const wheelRef = useRef(null);
  wheelRef.current = (e) => {
    if (e.shiftKey) { e.preventDefault(); view.current.rot = (view.current.rot || 0) + (e.deltaY < 0 ? -1 : 1) * 0.08; draw(); }
    else if (e.ctrlKey || e.metaKey) { e.preventDefault(); applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12); }
  };
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const h = (e) => wheelRef.current?.(e);
    c.addEventListener("wheel", h, { passive: false });
    return () => c.removeEventListener("wheel", h);
  }, []);

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

  // real-world size helpers (plan px <-> feet), and a length label in the user's units
  const pxPerFt = () => (scale ? (scale.unit === "ft" ? scale.pixelsPerUnit : scale.pixelsPerUnit * FT_TO_M) : (img ? img.w / 40 : 24));
  const lenLabel = (px) => { const f = pxToFeet(px, scale); return f == null ? null : fmtLen(f, units); };

  // room-name pills on screen (shared by drawing and hit-testing)
  const labelFont = "600 12px ui-sans-serif, system-ui, sans-serif";
  const roomPills = () => {
    const c = canvasRef.current; if (!c) return [];
    const x = c.getContext("2d"); x.font = labelFont;
    return rooms.filter((r) => r.name).map((r) => { const p = toScreen(r.x, r.y), tw = x.measureText(r.name).width; return { r, x: p.x, y: p.y, hw: tw / 2 + 6, hh: 10 }; });
  };
  const hitRoom = (sx, sy) => {
    const pad = 4 * HIT, list = roomPills();
    for (let i = list.length - 1; i >= 0; i--) { const q = list[i]; if (Math.abs(sx - q.x) <= q.hw + pad && Math.abs(sy - q.y) <= q.hh + pad) return q.r; }
    return null;
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
    else if (kind === "room") setRooms((a) => a.filter((r) => r.id !== id));
    else delBox(kind, id);
    setSelected(null);
  };
  // hit-test boxes: a resize handle of the selected box wins, else the topmost body under the point
  const hitBox = (px, py, sx, sy) => {
    const list = boxList();
    if (selected) {
      const f = list.find((b) => b.kind === selected.kind && b.o.id === selected.id);
      if (f) for (const cn of boxCorners(f.o)) { const p = toScreen(cn.x, cn.y); if (Math.hypot(p.x - sx, p.y - sy) < 11 * HIT) return { ...f, corner: cn }; }
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
    const hitR = (10 * HIT) / tf.current.s;

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
    if (tool === "item") {
      const f = ITEM_FT[addType] || ITEM_FT.other, k = pxPerFt();
      const o = { id: nid(), x, y, w: f[0] * k, h: f[1] * k, deg: 0 };
      onPushHistory?.();
      if (addType === "stairs") { setStairs((a) => [...a, o]); setSelected({ kind: "stair", id: o.id }); }
      else { setFurniture((a) => [...a, { ...o, type: addType }]); setSelected({ kind: "furn", id: o.id }); }
      setTool("move");
      return;
    }
    if (tool === "label") { drag.current = { type: "label", x, y }; return; } // asks for the name on release
    if (tool === "erase") {
      const rh = hitRoom(sx, sy);
      if (rh) { onPushHistory?.(); setRooms((a) => a.filter((r) => r.id !== rh.id)); return; }
      // opening first
      const oh = openings.find((o) => { const p = toScreen(o.x, o.y); return Math.hypot(p.x - sx, p.y - sy) < 10 * HIT; });
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
        if (Math.hypot(p.x - sx, p.y - sy) < 9 * HIT) { setSelected({ kind: "wall", id: w.id }); drag.current = { type: "endpoint", id: w.id, end }; return; }
      }
    }
    const oh = openings.find((o) => { const p = toScreen(o.x, o.y); return Math.hypot(p.x - sx, p.y - sy) < 9 * HIT; });
    if (oh) { setSelected({ kind: "opening", id: oh.id }); drag.current = { type: "opening", id: oh.id }; return; }
    const rh = hitRoom(sx, sy);
    if (rh) { setSelected({ kind: "room", id: rh.id }); drag.current = { type: "roommove", id: rh.id, gx: rh.x - x, gy: rh.y - y }; return; }
    if (bh) { setSelected({ kind: bh.kind, id: bh.o.id }); drag.current = { type: "boxmove", kind: bh.kind, id: bh.o.id, gx: bh.o.x - x, gy: bh.o.y - y }; return; }
    // tap on a wall line (away from its ends): select it and drag the whole wall
    const nw = nearestWall(x, y);
    if (nw && nw.dist < (12 * HIT) / tf.current.s) {
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
    if (!d.histPushed && ["endpoint", "wallmove", "opening", "boxmove", "boxresize", "roommove"].includes(d.type)) { onPushHistory?.(); d.histPushed = true; }
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
    } else if (d.type === "roommove") {
      setRooms((a) => a.map((r) => (r.id === d.id ? { ...r, x: x + d.gx, y: y + d.gy } : r)));
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
    if (d?.type === "label") {
      // asked on release, so the rest of this tap can't pull focus away from the name box
      ask?.({ title: "Name this room", input: "", confirmLabel: "Add" }).then((name) => {
        if (!name) return;
        onPushHistory?.();
        const r = { id: nid(), name: name.slice(0, 40), x: d.x, y: d.y };
        setRooms((a) => [...a, r]); setSelected({ kind: "room", id: r.id }); setTool("move");
      });
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
    dims = `${lenLabel(maxx - minx)} × ${lenLabel(maxy - miny)}`;
  }

  const uncertainCount = walls.filter((w) => (w.conf ?? 1) < 0.6).length;

  // ---- Issues: things worth a look before walking, each one tap-to-jump ----
  const issues = useMemo(() => {
    const out = [];
    const W = tidy ? tidied : walls;
    if (walls.length < 3) out.push({ key: "few", text: "Add at least 3 walls so you can walk through it.", tool: "wall" });
    if (!scale) out.push({ key: "scale", text: "The real size isn't set, so sizes are a guess.", tool: "scale" });
    walls.forEach((w) => { if ((w.conf ?? 1) < 0.6) out.push({ key: "u" + w.id, text: "A wall we weren't sure about.", sel: { kind: "wall", id: w.id }, at: [(w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2] }); });
    let loose = 0;
    W.forEach((w) => [[w.x1, w.y1], [w.x2, w.y2]].forEach(([ex, ey], k) => {
      if (loose >= 8) return;
      const meets = W.some((o) => o.id !== w.id && pointSeg(ex, ey, o.x1, o.y1, o.x2, o.y2).dist <= TIDY_WELD_PX);
      if (!meets) { loose++; out.push({ key: "e" + w.id + k, text: "A wall end that doesn't meet another wall.", sel: { kind: "wall", id: w.id }, at: [ex, ey] }); }
    }));
    openings.forEach((o) => {
      let best = 1e9; W.forEach((w) => { best = Math.min(best, pointSeg(o.x, o.y, w.x1, w.y1, w.x2, w.y2).dist); });
      if (best > 14) out.push({ key: "o" + o.id, text: `A ${o.type} that isn't on a wall.`, sel: { kind: "opening", id: o.id }, at: [o.x, o.y] });
    });
    return out;
  }, [walls, tidied, tidy, openings, scale]);
  const [showIssues, setShowIssues] = useState(false);
  // center the view on a plan point (pan is applied before the view's rotation)
  const focusOn = (px, py) => {
    recompute();
    const p = toScreen(px, py), dx = size.w / 2 - p.x, dy = size.h / 2 - p.y, th = view.current.rot || 0;
    view.current.panx += Math.cos(th) * dx + Math.sin(th) * dy;
    view.current.pany += -Math.sin(th) * dx + Math.cos(th) * dy;
    if (view.current.zoom < 1.6) view.current.zoom = 1.6;
    draw();
  };
  const openIssue = (it) => {
    if (it.tool) { setTool(it.tool); setSelected(null); if (it.tool === "scale") setScaleDraft(null); return; }
    setTool("move"); setSelected(it.sel); if (it.at) focusOn(it.at[0], it.at[1]);
  };

  const [sharing, setSharing] = useState(false);
  const tools = [["move", "Move"], ["wall", "Add wall"], ["door", "Door"], ["window", "Window"], ["item", "Add item"], ["label", "Room name"], ["scale", "Set real size"], ["erase", "Erase"]];
  const toolHint = {
    wall: "Drag to draw a wall. Ends snap onto nearby corners.",
    door: "Tap on a wall to add a door.",
    window: "Tap on a wall to add a window.",
    item: null,
    label: "Tap where the room's name should go.",
    erase: "Tap anything to remove it.",
  }[tool];
  const btn = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" };

  // the piece that's selected right now, for the bar over the drawing
  let sel = null;
  if (selected) {
    if (selected.kind === "wall") { const o = walls.find((w) => w.id === selected.id); sel = o && { kind: "wall", o }; }
    else if (selected.kind === "opening") { const o = openings.find((q) => q.id === selected.id); sel = o && { kind: "opening", o }; }
    else if (selected.kind === "room") { const o = rooms.find((r) => r.id === selected.id); sel = o && { kind: "room", o }; }
    else sel = boxList().find((b) => b.kind === selected.kind && b.o.id === selected.id) || null;
  }
  const setOpeningWidth = (id, w) => setOpenings((a) => a.map((q) => (q.id === id ? { ...q, w: Math.max(4, w) } : q)));
  const inch = scale ? pxPerFt() / 12 : null; // plan px per inch, when the real size is known

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-5">
      {error && (
        <div role="alert" className="mb-3 text-sm rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fde68a" }}>
          <span className="flex-1 min-w-[12rem]">{error}</span>
          {onRetry && <button onClick={onRetry} className="min-h-10 px-3 rounded-lg text-sm font-medium text-white shrink-0" style={{ background: "#6d5ae6" }}>Try again</button>}
        </div>
      )}
      {notice && (
        <div role="status" className="mb-3 text-sm rounded-lg px-3 py-2 flex items-center gap-3" style={{ background: "rgba(124,255,203,0.08)", border: "1px solid rgba(124,255,203,0.3)", color: "#c9fbe8" }}>
          <span className="flex-1">{notice}</span>
          <button onClick={() => onNotice?.(null)} aria-label="Dismiss" className="min-w-9 min-h-9 rounded text-slate-300">✕</button>
        </div>
      )}

      {/* tools */}
      <div className="flex flex-wrap items-center gap-2 mb-2" role="toolbar" aria-label="Editing tools">
        {tools.map(([k, label]) => (
          <button key={k} onClick={() => { setTool(k); setSelected(null); if (k === "scale") setScaleDraft(null); }} aria-pressed={tool === k}
            className="pointer-coarse:min-h-11 px-3 py-1.5 rounded-lg text-sm"
            style={{ background: tool === k ? "#6d5ae6" : "rgba(255,255,255,0.06)", border: "1px solid " + (tool === k ? "#8b78ff" : "rgba(255,255,255,0.12)"), color: tool === k ? "#fff" : "#cbd5e1" }}>
            {label}
          </button>
        ))}
        <span className="flex gap-1">
          <button onClick={() => onUndo?.()} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo"
            className="pointer-coarse:min-h-11 px-2.5 py-1.5 rounded-lg text-sm disabled:opacity-40" style={{ ...btn, color: "#cbd5e1" }}>↶ Undo</button>
          <button onClick={() => onRedo?.()} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo"
            className="pointer-coarse:min-h-11 px-2.5 py-1.5 rounded-lg text-sm disabled:opacity-40" style={{ ...btn, color: "#cbd5e1" }}>↷ Redo</button>
        </span>
        <div className="flex-1" />
        <button onClick={() => { setSharing(false); setNameDraft(savedName || ""); setSaving((v) => !v); }} title="Save this plan in this browser"
          className="pointer-coarse:min-h-11 px-2.5 py-1.5 rounded-lg text-sm text-slate-200" style={btn}>💾 Save</button>
        <button onClick={() => { setSaving(false); setSharing((v) => !v); }} aria-expanded={sharing}
          className="pointer-coarse:min-h-11 px-2.5 py-1.5 rounded-lg text-sm text-slate-200" style={btn}>⇪ Share &amp; download</button>
        <button onClick={() => { onPushHistory?.(); onRotate(); }} title="Turn the whole plan 90° (twist two fingers to turn just the view)"
          className="pointer-coarse:min-h-11 px-2.5 py-1.5 rounded-lg text-sm text-slate-200" style={btn}>↻ Rotate 90°</button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs text-slate-300">
        <label className="flex items-center gap-1.5 select-none cursor-pointer min-h-9">
          <input type="checkbox" className="w-4 h-4" checked={tidy} onChange={(e) => setTidy?.(e.target.checked)} /> tidy up the drawing
        </label>
        {img?.url && (
          <label className="flex items-center gap-1.5 select-none cursor-pointer min-h-9">
            <input type="checkbox" className="w-4 h-4" checked={showImg} onChange={(e) => setShowImg(e.target.checked)} /> show my photo
          </label>
        )}
        {toolHint && <span className="text-slate-300">{toolHint}</span>}
      </div>

      {saving && (
        <div className="mb-3 rounded-lg px-3 py-3 text-sm flex flex-wrap items-center gap-2" style={{ background: "rgba(124,99,255,0.1)", border: "1px solid rgba(124,99,255,0.3)" }}>
          <label htmlFor="bw-plan-name" className="text-slate-200">Name this plan:</label>
          <input id="bw-plan-name" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={40}
            onKeyDown={(e) => { if (e.key === "Enter") onSave?.(nameDraft); }}
            placeholder="e.g. Our house" className="min-h-10 px-2 rounded bg-black/30 border border-white/15 text-white" />
          <button onClick={() => onSave?.(nameDraft)} className="min-h-10 px-3 rounded text-white" style={{ background: "#6d5ae6" }}>Save</button>
          <button onClick={() => setSaving(false)} className="min-h-10 px-3 rounded text-slate-300" style={btn}>Close</button>
          <span aria-live="polite" style={{ color: "#7CFFCB" }}>{saveStatus}</span>
          <span className="w-full text-xs text-slate-400">Saved in this browser only. Find it under “My plans” on the start screen. To move it to another device, use Share &amp; download.</span>
        </div>
      )}

      {sharing && (
        <div className="mb-3 rounded-lg px-3 py-3 text-sm" style={{ background: "rgba(124,99,255,0.1)", border: "1px solid rgba(124,99,255,0.3)" }}>
          <div className="flex flex-wrap gap-2">
            <button onClick={onShareLink} className="min-h-10 px-3 rounded-lg text-white" style={{ background: "#6d5ae6" }}>🔗 Copy a share link</button>
            <button onClick={onExportImage} className="min-h-10 px-3 rounded-lg text-slate-200" style={btn}>🖼 Download a picture</button>
            <button onClick={onExportFile} className="min-h-10 px-3 rounded-lg text-slate-200" style={btn}>⬇ Download the plan file</button>
            <button onClick={() => setSharing(false)} className="min-h-10 px-3 rounded-lg text-slate-300 ml-auto" style={btn}>Close</button>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            A share link holds the layout itself (not your photo), so anyone with the link can see it. The plan file keeps everything, photo included, and opens from “Open a plan file” on the start screen.
          </p>
        </div>
      )}

      {/* item picker for "Add item" */}
      {tool === "item" && (
        <div className="mb-3 rounded-lg px-3 py-2.5 text-sm flex flex-wrap items-center gap-2" style={{ background: "rgba(94,234,212,0.08)", border: "1px solid rgba(94,234,212,0.3)" }}>
          <label htmlFor="bw-item" className="text-slate-200">Add a</label>
          <select id="bw-item" value={addType} onChange={(e) => setAddType(e.target.value)} className="min-h-10 px-2 rounded bg-black/30 border border-white/15 text-white">
            {ITEM_TYPES.map((k) => <option key={k} value={k}>{prettyType(k)}</option>)}
          </select>
          <span className="text-slate-300">then tap the plan where it goes. You can drag it and resize it after.</span>
        </div>
      )}

      {/* real-size panel (above the drawing, so it's on screen while you draw the line) */}
      {tool === "scale" && (
        <div className="mb-3 rounded-lg px-3 py-3 text-sm" style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)" }}>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-amber-200 mr-1">How do you want to set the real size?</span>
            {[["grid", "On grid paper"], ["wall", "I know a wall's length"]].map(([k, label]) => (
              <button key={k} onClick={() => setScaleMode(k)} aria-pressed={scaleMode === k} className="min-h-9 px-2.5 rounded text-xs"
                style={{ background: scaleMode === k ? "#d97706" : "rgba(255,255,255,0.06)", border: "1px solid " + (scaleMode === k ? "#f59e0b" : "rgba(255,255,255,0.15)"), color: scaleMode === k ? "#fff" : "#fde68a" }}>
                {label}
              </button>
            ))}
          </div>
          {scaleMode === "grid" ? (
            <div className="flex flex-wrap items-center gap-2 text-amber-100">
              <span>Drag a line along the grid, then tell me how many squares it crossed:</span>
              <input type="number" inputMode="decimal" aria-label="Number of squares" placeholder="squares" value={scaleInput.squares}
                onChange={(e) => setScaleInput((s) => ({ ...s, squares: e.target.value }))}
                className="w-24 min-h-10 px-2 rounded bg-black/30 border border-white/15 text-white" />
              <span className="text-amber-200/80">squares,</span>
              <input type="number" inputMode="decimal" aria-label="Feet per square" value={scaleInput.ftPerSq}
                onChange={(e) => setScaleInput((s) => ({ ...s, ftPerSq: e.target.value }))}
                className="w-16 min-h-10 px-2 rounded bg-black/30 border border-white/15 text-white" />
              <span className="text-amber-200/80">ft per square</span>
              <button onClick={applyScale} disabled={!scaleInput._px || !(parseFloat(scaleInput.squares) > 0)}
                className="min-h-10 px-3 rounded text-white disabled:opacity-40" style={{ background: "#d97706" }}>Set</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-amber-100">
              <span>Trace one wall you know the length of, then type how long it really is:</span>
              <input type="number" inputMode="decimal" aria-label="Real length" placeholder="length" value={scaleInput.len}
                onChange={(e) => setScaleInput((s) => ({ ...s, len: e.target.value }))}
                className="w-24 min-h-10 px-2 rounded bg-black/30 border border-white/15 text-white" />
              <select aria-label="Unit" value={scaleInput.unit} onChange={(e) => setScaleInput((s) => ({ ...s, unit: e.target.value }))}
                className="min-h-10 px-2 rounded bg-black/30 border border-white/15 text-white">
                <option value="ft">feet</option><option value="m">meters</option>
              </select>
              <button onClick={applyScale} disabled={!scaleInput._px || !scaleInput.len}
                className="min-h-10 px-3 rounded text-white disabled:opacity-40" style={{ background: "#d97706" }}>Set</button>
            </div>
          )}
          <div className="text-xs mt-2" style={{ color: scaleInput._px ? "#7CFFCB" : "rgba(253,230,138,0.8)" }}>
            {scaleInput._px ? "✓ Line measured. Now fill in the value and press Set." : "First drag a line on the plan below."}
          </div>
        </div>
      )}

      <div ref={wrapRef} className="rounded-xl overflow-hidden relative" style={{ border: "1px solid rgba(255,255,255,0.12)", touchAction: "none" }}>
        <canvas ref={canvasRef} aria-label="Floor plan editor"
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
          style={{ display: "block", cursor: tool === "move" ? "grab" : "crosshair" }} />

        {/* the selected piece: pinned over the top of the drawing so it's always on screen */}
        {sel && (
          <div className="absolute top-2 left-2 right-2 rounded-lg px-3 py-2 flex flex-wrap items-center gap-2 text-sm"
            style={{ background: "rgba(16,13,38,0.92)", border: "1px solid rgba(124,255,203,0.35)" }}>
            <span style={{ color: "#7CFFCB" }}>
              {sel.kind === "furn" ? prettyType(sel.o.type) : sel.kind === "stair" ? "Stairs" : sel.kind === "room" ? "Room name"
                : sel.kind === "wall" ? ((sel.o.conf ?? 1) < 0.6 ? "Wall (unsure)" : "Wall") : (sel.o.type === "door" ? "Door" : "Window")}
            </span>
            {sel.kind === "wall" && (
              <span className="text-slate-300">{lenLabel(Math.hypot(sel.o.x2 - sel.o.x1, sel.o.y2 - sel.o.y1)) ?? "set the real size to see its length"}</span>
            )}
            {sel.kind === "wall" && (sel.o.conf ?? 1) < 0.6 && (
              <button onClick={() => { onPushHistory?.(); setWalls((a) => a.map((w) => w.id === sel.o.id ? { ...w, conf: 1 } : w)); }}
                className="min-h-9 px-2.5 rounded text-xs text-white" style={{ background: "rgba(124,255,203,0.18)", border: "1px solid rgba(124,255,203,0.45)" }}>looks right ✓</button>
            )}
            {sel.kind === "furn" && (
              <select aria-label="What this is" value={sel.o.type} onChange={(e) => { onPushHistory?.(); setBox("furn", sel.o.id, { type: e.target.value }); }}
                className="min-h-9 px-2 rounded bg-black/30 border border-white/15 text-white">
                {FURN_TYPE_LIST.map((k) => <option key={k} value={k}>{prettyType(k)}</option>)}
              </select>
            )}
            {(sel.kind === "furn" || sel.kind === "stair") && scale && (
              <span className="text-slate-300 text-xs">{lenLabel(sel.o.w)} × {lenLabel(sel.o.h)}</span>
            )}
            {sel.kind === "opening" && (
              <>
                <button onClick={() => { onPushHistory?.(); setOpeningWidth(sel.o.id, sel.o.w - (inch ? 2 * inch : sel.o.w * 0.1)); }} aria-label="Narrower"
                  className="min-w-9 min-h-9 rounded text-white" style={btn}>−</button>
                <span className="text-slate-200 text-xs min-w-[4.5rem] text-center">{inch ? `${Math.round(sel.o.w / inch)}" wide` : "width"}</span>
                <button onClick={() => { onPushHistory?.(); setOpeningWidth(sel.o.id, sel.o.w + (inch ? 2 * inch : sel.o.w * 0.1)); }} aria-label="Wider"
                  className="min-w-9 min-h-9 rounded text-white" style={btn}>+</button>
                <button onClick={() => { onPushHistory?.(); setOpenings((o) => o.map((q) => q.id === sel.o.id ? { ...q, type: q.type === "door" ? "window" : "door" } : q)); }}
                  className="min-h-9 px-2.5 rounded text-xs text-white" style={btn}>make it a {sel.o.type === "door" ? "window" : "door"}</button>
              </>
            )}
            {sel.kind === "room" && (
              <input aria-label="Room name" value={sel.o.name} maxLength={40}
                onFocus={() => onPushHistory?.()}
                onChange={(e) => { const v = e.target.value; setRooms((a) => a.map((r) => r.id === sel.o.id ? { ...r, name: v } : r)); }}
                onBlur={(e) => { if (!e.target.value.trim()) setRooms((a) => a.filter((r) => r.id !== sel.o.id)); }}
                className="min-h-9 px-2 rounded bg-black/30 border border-white/15 text-white w-40" />
            )}
            <span className="text-slate-400 text-xs hidden sm:inline">
              {sel.kind === "wall" ? "drag to move · drag an end to reshape" : sel.kind === "opening" ? "drag it along a wall" : sel.kind === "room" ? "drag to move it" : "drag to move · drag a corner to resize"}
            </span>
            <span className="flex-1" />
            <button onClick={deleteSelected} className="min-h-9 px-3 rounded text-white text-xs font-medium" style={{ background: "#b4444e" }}>Delete</button>
            <button onClick={() => setSelected(null)} aria-label="Done" className="min-h-9 px-2.5 rounded text-xs text-slate-200" style={btn}>Done</button>
          </div>
        )}

        {/* zoom controls (pinch to zoom + two-finger drag to pan also work) */}
        <div className="absolute bottom-3 right-3 flex flex-col gap-1.5 select-none">
          {[["+", () => applyZoom(1.3), "Zoom in"], ["⤢", fitView, "Fit to screen"], ["−", () => applyZoom(1 / 1.3), "Zoom out"]].map(([label, fn, name]) => (
            <button key={name} onClick={fn} title={name} aria-label={name}
              className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-lg font-medium text-white flex items-center justify-center"
              style={{ background: "rgba(20,16,46,0.85)", border: "1px solid rgba(255,255,255,0.18)" }}>{label}</button>
          ))}
        </div>
      </div>

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
              <span aria-hidden="true" style={{
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
          <span style={{ color: "#fbbf24" }}>Tap “Set real size” so lengths are right (otherwise it's a guess)</span>
        )}
        <div role="radiogroup" aria-label="Units" className="flex rounded-lg overflow-hidden ml-auto" style={btn}>
          {[["ft", "ft"], ["m", "m"]].map(([k, label]) => (
            <button key={k} role="radio" aria-checked={units === k} onClick={() => setUnits?.(k)}
              className="min-h-9 px-3 text-xs" style={{ background: units === k ? "#6d5ae6" : "transparent", color: units === k ? "#fff" : "#cbd5e1" }}>{label}</button>
          ))}
        </div>
        <label className="text-slate-300 flex items-center gap-2">ceiling
          <input type="range" min="7" max="11" step="0.5" value={ceiling} onChange={(e) => setCeiling(parseFloat(e.target.value))} aria-label="Ceiling height" />
          <span className="text-slate-200 w-14">{fmtLen(ceiling, units)}</span>
        </label>
      </div>

      {/* Issues: worth a look before walking */}
      <div className="mt-3">
        <button onClick={() => setShowIssues((v) => !v)} aria-expanded={showIssues}
          className="min-h-10 px-3 rounded-lg text-sm flex items-center gap-2"
          style={{ ...btn, color: issues.length ? "#fde68a" : "#7CFFCB" }}>
          {issues.length ? `⚠ ${issues.length} thing${issues.length > 1 ? "s" : ""} to check` : "✓ Nothing to check"}
          {issues.length > 0 && <span className="text-slate-400 text-xs">{showIssues ? "hide" : "show"}</span>}
        </button>
        {showIssues && issues.length > 0 && (
          <ul className="mt-2 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(251,191,36,0.3)" }}>
            {issues.slice(0, 20).map((it) => (
              <li key={it.key} className="border-b border-white/5 last:border-b-0">
                <button onClick={() => openIssue(it)} className="w-full text-left min-h-11 px-3 py-2 text-sm text-amber-100 hover:bg-white/5">
                  {it.text} <span className="text-slate-400 text-xs">{it.tool ? "→ fix it" : "→ show me"}</span>
                </button>
              </li>
            ))}
            {issues.length > 20 && <li className="px-3 py-2 text-xs text-slate-400">and {issues.length - 20} more</li>}
          </ul>
        )}
      </div>

      <div className="mt-5 flex gap-3">
        <button onClick={onBack} className="min-h-11 px-4 rounded-lg text-sm text-slate-300" style={btn}>← Back</button>
        <button onClick={onWalk} disabled={walls.length < 3}
          className="min-h-11 px-5 rounded-lg text-sm font-semibold text-white ml-auto disabled:opacity-40"
          style={{ background: "#6d5ae6" }}>
          Build &amp; walk it →
        </button>
      </div>
      <p className="text-xs text-slate-400 mt-2">
        {IS_TOUCH
          ? "Tip: pinch to zoom, twist two fingers to turn the view. Wall ends snap onto nearby corners."
          : "Tip: Ctrl/Cmd + scroll (or pinch on a trackpad) to zoom, Shift + scroll to turn the view. Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes, Delete removes what's selected."}
      </p>
    </div>
  );
}
