import React, { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";

/*  Blueprint → Walkable 3D  ·  end-to-end pipeline prototype
    Stages: upload → analyze (Claude vision) → calibrate + correct (2D editor) → walk (Three.js FPS)
    Coordinate spaces:
      - "plan px"  : the downscaled source-image pixel space (origin top-left, y down). All walls/openings stored here.
      - "world m"  : meters in Three.js (x right, z = plan-y, y up). mPerPx = unitMeters / pixelsPerUnit.
*/

// ---------- constants ----------
const MAX_DIM = 1024;          // downscale source image to this max dimension before vision + editing
const CEILING_M = 2.7;         // default ceiling height (m)
const WALL_T_M = 0.12;         // wall thickness (m)
const DOOR_TOP_M = 2.05;       // top of a door opening
const WIN_SILL_M = 0.9;        // bottom of a window opening
const WIN_TOP_M = 2.1;         // top of a window opening
const EYE_M = 1.6;             // camera eye height
const FT_TO_M = 0.3048;

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

// ---------- root component ----------
export default function FloorPlanWalker() {
  const [stage, setStage] = useState("upload"); // upload | analyzing | editor | walk
  const [img, setImg] = useState(null);         // { url, w, h }
  const [walls, setWalls] = useState([]);        // { id, x1,y1,x2,y2 } in plan px
  const [openings, setOpenings] = useState([]);  // { id, x,y,w, type:'door'|'window' } center in plan px
  const [scale, setScale] = useState(null);      // { pixelsPerUnit, unit:'ft'|'m' }
  const [ceiling, setCeiling] = useState(CEILING_M);
  const [error, setError] = useState(null);

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
        setWalls([]); setOpenings([]); setScale(null);
      };
      im.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }, []);

  // ---- Claude vision extraction ----
  const analyze = useCallback(async () => {
    if (!img) return;
    setStage("analyzing"); setError(null);
    const base64 = img.url.split(",")[1];
    const prompt =
`You vectorize house floor plans (often hand-drawn). The image is ${img.w}px wide, ${img.h}px tall. Origin top-left, x right, y down.
Return ONLY compact JSON, no markdown, no prose:
{"w":[[x1,y1,x2,y2]],"d":[[cx,cy,wpx]],"win":[[cx,cy,wpx]],"scale":{"px":N,"unit":"ft","len":N},"rooms":[["Name",cx,cy]]}
Rules:
- "w": every wall as a straight segment between two endpoints, in pixels. Trace the full outer perimeter AND all interior walls. Merge collinear runs; snap to right angles where the drawing intends them.
- "d": door openings as [centerX, centerY, approxWidthPx].
- "win": window openings as [centerX, centerY, approxWidthPx].
- "scale": if any dimension/measure text is legible, pick ONE clear wall, give its pixel length "px", real length "len", and "unit" ("ft" or "m"). Otherwise null.
- "rooms": legible room labels with center point, else [].
Output JSON only.`;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });
      const data = await res.json();
      let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      const p = JSON.parse(text.slice(s, e + 1));
      const nw = (p.w || []).filter(a => a && a.length === 4).map(a => ({ id: nid(), x1: a[0], y1: a[1], x2: a[2], y2: a[3] }));
      const no = [
        ...(p.d || []).map(a => ({ id: nid(), x: a[0], y: a[1], w: a[2] || 30, type: "door" })),
        ...(p.win || []).map(a => ({ id: nid(), x: a[0], y: a[1], w: a[2] || 30, type: "window" })),
      ];
      setWalls(nw); setOpenings(no);
      if (p.scale && p.scale.px && p.scale.len) {
        setScale({ pixelsPerUnit: p.scale.px / p.scale.len, unit: p.scale.unit === "m" ? "m" : "ft" });
      }
      setStage("editor");
    } catch (err) {
      setError("Couldn't read the plan automatically. Open the editor and trace the walls by hand — every tool still works.");
      setStage("editor");
    }
  }, [img]);

  const loadSample = useCallback(() => {
    // simple 2-bed shell sized for a 1024-wide canvas
    setImg({ url: null, w: 1024, h: 720 });
    const W = (x1, y1, x2, y2) => ({ id: nid(), x1, y1, x2, y2 });
    setWalls([
      W(120, 120, 904, 120), W(904, 120, 904, 600), W(904, 600, 120, 600), W(120, 600, 120, 120), // outer
      W(512, 120, 512, 360), // hall divider
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
    setScale({ pixelsPerUnit: 1024 / 12, unit: "m" }); // assume 12 m wide
    setStage("editor");
  }, []);

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
      className="w-full min-h-screen text-slate-100"
    >
      <div className="min-h-screen w-full" style={{ background: "radial-gradient(1200px 600px at 70% -10%, #2a1f5e 0%, #15122e 45%, #0c0a1f 100%)" }}>
        <Header stage={stage} />
        {stage === "upload" && (
          <Upload img={img} onFile={ingest} onAnalyze={analyze} onSample={loadSample} onReset={() => setImg(null)} />
        )}
        {stage === "analyzing" && <Analyzing />}
        {stage === "editor" && (
          <Editor
            img={img} walls={walls} setWalls={setWalls}
            openings={openings} setOpenings={setOpenings}
            scale={scale} setScale={setScale}
            ceiling={ceiling} setCeiling={setCeiling}
            error={error}
            onWalk={() => setStage("walk")}
            onBack={() => { setStage("upload"); }}
          />
        )}
        {stage === "walk" && (
          <Walk walls={walls} openings={openings} scale={scale} ceiling={ceiling} onExit={() => setStage("editor")} />
        )}
      </div>
    </div>
  );
}

// ---------- header ----------
function Header({ stage }) {
  const steps = [["upload", "Capture"], ["analyzing", "Read"], ["editor", "Correct & scale"], ["walk", "Walk it"]];
  const idx = { upload: 0, analyzing: 1, editor: 2, walk: 3 }[stage];
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 backdrop-blur"
      style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="flex items-baseline gap-3">
        <span className="text-base font-semibold tracking-tight" style={{ color: "#c7b6ff" }}>Blueprint Walker</span>
        <span className="text-xs text-slate-400 hidden sm:inline">hand-drawn plan → walkable, to-scale space</span>
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
      </div>
    </div>
  );
}

// ---------- upload ----------
function Upload({ img, onFile, onAnalyze, onSample, onReset }) {
  const fileRef = useRef(null), camRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const drop = (e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); };

  return (
    <div className="max-w-3xl mx-auto px-5 py-10">
      {!img ? (
        <>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-2">Turn a drawing into a space you can walk through.</h1>
          <p className="text-slate-400 mb-7 text-sm">Upload or photograph a floor plan — hand-drawn is fine. Claude reads the walls, you correct anything it got wrong, set the real scale, then step inside.</p>
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
              <button onClick={onSample} className="px-4 py-2 rounded-lg text-sm font-medium text-slate-200" style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)" }}>Try a sample</button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </div>
        </>
      ) : (
        <div className="text-center">
          <h2 className="text-lg font-medium mb-4">Ready to read this plan.</h2>
          <div className="inline-block rounded-xl overflow-hidden mb-5" style={{ border: "1px solid rgba(255,255,255,0.12)", maxWidth: "100%" }}>
            {img.url ? <img src={img.url} alt="floor plan" style={{ maxHeight: 420, display: "block" }} /> : <div className="px-16 py-12 text-slate-400">sample plan loaded</div>}
          </div>
          <div className="flex gap-3 justify-center">
            <button onClick={onAnalyze} className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white" style={{ background: "#6d5ae6" }}>Read the walls →</button>
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
      <p className="text-slate-300">Reading the drawing — tracing walls, doors, and windows…</p>
      <p className="text-slate-500 text-xs mt-2">Vision models propose; you'll get to correct everything next.</p>
    </div>
  );
}

// ================= 2D EDITOR =================
function Editor({ img, walls, setWalls, openings, setOpenings, scale, setScale, ceiling, setCeiling, error, onWalk, onBack }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const tf = useRef({ s: 1, ox: 0, oy: 0 });      // plan→screen transform
  const drag = useRef(null);                       // active interaction
  const [tool, setTool] = useState("move");
  const [showImg, setShowImg] = useState(true);
  const [scaleDraft, setScaleDraft] = useState(null); // {x1,y1,x2,y2}
  const [scaleInput, setScaleInput] = useState({ len: "", unit: scale?.unit || "ft" });
  const [size, setSize] = useState({ w: 800, h: 560 });
  const bg = useRef(null);

  // load source image once for the faded background
  useEffect(() => {
    if (img?.url) { const i = new Image(); i.onload = () => { bg.current = i; draw(); }; i.src = img.url; }
    else bg.current = null;
  }, [img]);

  // size canvas to its container
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current; if (!el) return;
      setSize({ w: el.clientWidth, h: Math.max(360, Math.min(640, el.clientWidth * (img ? img.h / img.w : 0.66))) });
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [img]);

  // compute transform (fit plan into canvas)
  const recompute = useCallback(() => {
    if (!img) return;
    const pad = 20;
    const s = Math.min((size.w - pad * 2) / img.w, (size.h - pad * 2) / img.h);
    tf.current = { s, ox: (size.w - img.w * s) / 2, oy: (size.h - img.h * s) / 2 };
  }, [img, size]);

  const toScreen = (x, y) => ({ x: tf.current.ox + x * tf.current.s, y: tf.current.oy + y * tf.current.s });
  const toPlan = (sx, sy) => ({ x: (sx - tf.current.ox) / tf.current.s, y: (sy - tf.current.oy) / tf.current.s });

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
      x.globalAlpha = 0.45;
      x.drawImage(bg.current, tf.current.ox, tf.current.oy, img.w * tf.current.s, img.h * tf.current.s);
      x.globalAlpha = 1;
    }
    // walls
    x.lineCap = "round";
    walls.forEach((w) => {
      const a = toScreen(w.x1, w.y1), b = toScreen(w.x2, w.y2);
      x.strokeStyle = "#c7b6ff"; x.lineWidth = 5;
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
      [a, b].forEach((p) => { x.fillStyle = "#1b1640"; x.strokeStyle = "#a48bff"; x.lineWidth = 2;
        x.beginPath(); x.rect(p.x - 4, p.y - 4, 8, 8); x.fill(); x.stroke(); });
    });
    // draft wall
    if (drag.current?.type === "newwall") {
      const a = toScreen(drag.current.x1, drag.current.y1), b = toScreen(drag.current.x2, drag.current.y2);
      x.strokeStyle = "#7CFFCB"; x.lineWidth = 4; x.setLineDash([6, 5]);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.setLineDash([]);
    }
    // openings
    openings.forEach((o) => {
      const p = toScreen(o.x, o.y);
      x.fillStyle = o.type === "door" ? "#34d399" : "#38bdf8";
      x.beginPath(); x.arc(p.x, p.y, 6, 0, Math.PI * 2); x.fill();
      x.strokeStyle = "rgba(0,0,0,0.4)"; x.lineWidth = 1.5; x.stroke();
    });
    // scale draft
    const sd = scaleDraft;
    if (sd) {
      const a = toScreen(sd.x1, sd.y1), b = toScreen(sd.x2, sd.y2);
      x.strokeStyle = "#fbbf24"; x.lineWidth = 3; x.setLineDash([5, 4]);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); x.setLineDash([]);
      [a, b].forEach((p) => { x.fillStyle = "#fbbf24"; x.beginPath(); x.arc(p.x, p.y, 4, 0, 7); x.fill(); });
    }
  }, [img, size, walls, openings, scaleDraft, showImg, recompute]);

  useEffect(() => { draw(); }, [draw]);

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

  const onDown = (e) => {
    e.preventDefault();
    const { sx, sy, x, y } = getXY(e);
    const hitR = 10 / tf.current.s;

    if (tool === "scale") { setScaleDraft({ x1: x, y1: y, x2: x, y2: y }); drag.current = { type: "scale" }; return; }
    if (tool === "wall") { drag.current = { type: "newwall", x1: x, y1: y, x2: x, y2: y }; return; }
    if (tool === "door" || tool === "window") {
      const nw = nearestWall(x, y);
      if (nw && nw.dist < 40 / tf.current.s) {
        const um = scale ? (scale.unit === "ft" ? FT_TO_M : 1) : 1;
        const defW = scale ? ((tool === "door" ? 0.9 : 1.2) / um) * scale.pixelsPerUnit : 36;
        setOpenings((o) => [...o, { id: nid(), x: nw.cx, y: nw.cy, w: defW, type: tool }]);
      }
      return;
    }
    if (tool === "erase") {
      // opening first
      const oh = openings.find((o) => { const p = toScreen(o.x, o.y); return Math.hypot(p.x - sx, p.y - sy) < 10; });
      if (oh) { setOpenings((o) => o.filter((q) => q.id !== oh.id)); return; }
      const nw = nearestWall(x, y);
      if (nw && nw.dist < hitR * 1.5) setWalls((w) => w.filter((q) => q.id !== nw.w.id));
      return;
    }
    // move: grab an endpoint
    for (const w of walls) {
      for (const end of [1, 2]) {
        const ex = end === 1 ? w.x1 : w.x2, ey = end === 1 ? w.y1 : w.y2;
        const p = toScreen(ex, ey);
        if (Math.hypot(p.x - sx, p.y - sy) < 9) { drag.current = { type: "endpoint", id: w.id, end }; return; }
      }
    }
    // grab an opening to slide
    const oh = openings.find((o) => { const p = toScreen(o.x, o.y); return Math.hypot(p.x - sx, p.y - sy) < 9; });
    if (oh) drag.current = { type: "opening", id: oh.id };
  };

  const onMove = (e) => {
    if (!drag.current) return;
    const { x, y } = getXY(e);
    const d = drag.current;
    if (d.type === "endpoint") {
      setWalls((ws) => ws.map((w) => w.id === d.id ? (d.end === 1 ? { ...w, x1: x, y1: y } : { ...w, x2: x, y2: y }) : w));
    } else if (d.type === "newwall") {
      drag.current = { ...d, x2: x, y2: y }; draw();
    } else if (d.type === "scale") {
      setScaleDraft((s) => s && { ...s, x2: x, y2: y });
    } else if (d.type === "opening") {
      const nw = nearestWall(x, y);
      setOpenings((o) => o.map((q) => q.id === d.id ? { ...q, x: nw ? nw.cx : x, y: nw ? nw.cy : y } : q));
    }
  };

  const onUp = () => {
    const d = drag.current;
    if (d?.type === "newwall") {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 6 / tf.current.s)
        setWalls((w) => [...w, { id: nid(), x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }]);
    }
    if (d?.type === "scale") {
      const len = Math.hypot(scaleDraft.x2 - scaleDraft.x1, scaleDraft.y2 - scaleDraft.y1);
      if (len > 8) setScaleInput((s) => ({ ...s, _px: len }));
    }
    drag.current = null;
  };

  const applyScale = () => {
    const px = scaleInput._px, len = parseFloat(scaleInput.len);
    if (px && len > 0) { setScale({ pixelsPerUnit: px / len, unit: scaleInput.unit }); setScaleDraft(null); setScaleInput({ len: "", unit: scaleInput.unit }); setTool("move"); }
  };

  // derived: building size if scale set
  let dims = null;
  if (scale && walls.length) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    walls.forEach((w) => { minx = Math.min(minx, w.x1, w.x2); maxx = Math.max(maxx, w.x1, w.x2); miny = Math.min(miny, w.y1, w.y2); maxy = Math.max(maxy, w.y1, w.y2); });
    const u = (v) => (v / scale.pixelsPerUnit).toFixed(1);
    dims = `${u(maxx - minx)} × ${u(maxy - miny)} ${scale.unit}`;
  }

  const tools = [["move", "Move"], ["wall", "Add wall"], ["door", "Door"], ["window", "Window"], ["scale", "Set scale"], ["erase", "Erase"]];

  return (
    <div className="max-w-6xl mx-auto px-4 py-5">
      {error && <div className="mb-3 text-sm rounded-lg px-3 py-2" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fde68a" }}>{error}</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {tools.map(([k, label]) => (
          <button key={k} onClick={() => { setTool(k); if (k === "scale") setScaleDraft(null); }}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{ background: tool === k ? "#6d5ae6" : "rgba(255,255,255,0.06)", border: "1px solid " + (tool === k ? "#8b78ff" : "rgba(255,255,255,0.12)"), color: tool === k ? "#fff" : "#cbd5e1" }}>
            {label}
          </button>
        ))}
        <div className="flex-1" />
        <label className="text-xs text-slate-400 flex items-center gap-1 select-none cursor-pointer">
          <input type="checkbox" checked={showImg} onChange={(e) => setShowImg(e.target.checked)} /> show drawing
        </label>
      </div>

      <div ref={wrapRef} className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.12)", touchAction: "none" }}>
        <canvas ref={canvasRef}
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
          style={{ display: "block", cursor: tool === "move" ? "grab" : "crosshair" }} />
      </div>

      {/* scale input panel */}
      {tool === "scale" && (
        <div className="mt-3 rounded-lg px-3 py-3 flex flex-wrap items-center gap-3 text-sm" style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)" }}>
          <span className="text-amber-200">Drag a line along a wall of known length, then enter how long it really is:</span>
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

      {/* status bar */}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <span className="text-slate-400">{walls.length} walls · {openings.filter(o => o.type === "door").length} doors · {openings.filter(o => o.type === "window").length} windows</span>
        <span className="text-slate-400">·</span>
        {scale ? (
          <span style={{ color: "#7CFFCB" }}>Scale set{dims ? ` · footprint ≈ ${dims}` : ""}</span>
        ) : (
          <span style={{ color: "#fbbf24" }}>No scale yet — set one for true proportions (otherwise an estimate is used)</span>
        )}
        <label className="text-slate-400 flex items-center gap-2 ml-auto">ceiling
          <input type="range" min="2.2" max="3.6" step="0.1" value={ceiling} onChange={(e) => setCeiling(parseFloat(e.target.value))} />
          <span className="text-slate-300 w-10">{ceiling.toFixed(1)}m</span>
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
      <p className="text-xs text-slate-500 mt-2">Tip: drag wall endpoints to fix the trace, drop doors/windows onto walls, then “Set scale”. Doors become openings you can walk through.</p>
    </div>
  );
}

// ================= 3D WALK =================
function Walk({ walls, openings, scale, ceiling, onExit }) {
  const mountRef = useRef(null);
  const miniRef = useRef(null);
  const [locked, setLocked] = useState(false);
  const touchMove = useRef({ x: 0, y: 0 });

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
        box(sx, sz, ex, ez, 0, ceiling, WALL_T_M, wallMat);
        collide.push({ ax: sx, az: sz, bx: ex, bz: ez, ht: WALL_T_M / 2 + 0.02 });
      };
      ops.forEach((op) => {
        solid(cur, op.s);
        const [sx, sz] = at(op.s), [ex, ez] = at(op.e);
        if (op.type === "window") {
          box(sx, sz, ex, ez, 0, WIN_SILL_M, WALL_T_M, wallMat);        // sill
          box(sx, sz, ex, ez, WIN_TOP_M, ceiling, WALL_T_M, wallMat); // header
          box(sx, sz, ex, ez, WIN_SILL_M, WIN_TOP_M, WALL_T_M * 0.4, glassMat);
          collide.push({ ax: sx, az: sz, bx: ex, bz: ez, ht: WALL_T_M / 2 + 0.02 }); // can't walk through glass
        } else {
          box(sx, sz, ex, ez, DOOR_TOP_M, ceiling, WALL_T_M, wallMat); // lintel above door
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

    // touch look (right half of screen)
    let lookId = null, lastLX = 0, lastLY = 0;
    const tStart = (e) => {
      for (const t of e.changedTouches) {
        if (t.clientX - mount.getBoundingClientRect().left > mount.clientWidth * 0.4 && lookId === null) {
          lookId = t.identifier; lastLX = t.clientX; lastLY = t.clientY;
        }
      }
    };
    const tMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookId) {
          yaw -= (t.clientX - lastLX) * 0.005; pitch -= (t.clientY - lastLY) * 0.005;
          pitch = Math.max(-1.45, Math.min(1.45, pitch)); lastLX = t.clientX; lastLY = t.clientY;
          camera.rotation.set(pitch, yaw, 0, "YXZ");
        }
      }
    };
    const tEnd = (e) => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
    renderer.domElement.addEventListener("touchstart", tStart, { passive: true });
    renderer.domElement.addEventListener("touchmove", tMove, { passive: true });
    renderer.domElement.addEventListener("touchend", tEnd);

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
  }, [walls, openings, scale, ceiling]);

  // ---- touch joystick (left) ----
  const jBase = useRef(null);
  const onJoy = (e) => {
    const t = e.touches[0]; const r = jBase.current.getBoundingClientRect();
    let dx = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    touchMove.current = { x: dx, y: dy };
  };
  const endJoy = () => (touchMove.current = { x: 0, y: 0 });

  return (
    <div className="relative" style={{ height: "calc(100vh - 53px)" }}>
      <div ref={mountRef} className="absolute inset-0" />
      {/* crosshair */}
      <div className="absolute left-1/2 top-1/2 pointer-events-none" style={{ transform: "translate(-50%,-50%)", width: 6, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.7)" }} />
      {/* minimap */}
      <canvas ref={miniRef} className="absolute top-3 right-3 rounded-lg" style={{ width: 150, height: 150, border: "1px solid rgba(255,255,255,0.15)" }} />
      {/* enter overlay */}
      {!locked && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="px-4 py-2 rounded-lg text-sm text-slate-200" style={{ background: "rgba(20,16,46,0.7)", border: "1px solid rgba(255,255,255,0.15)" }}>
            Click to look around · <b>W A S D</b> move · <b>Shift</b> run · <b>Esc</b> release
          </div>
        </div>
      )}
      {/* exit */}
      <button onClick={onExit} className="absolute top-3 left-3 px-3 py-1.5 rounded-lg text-sm text-slate-200"
        style={{ background: "rgba(20,16,46,0.8)", border: "1px solid rgba(255,255,255,0.15)" }}>← Edit plan</button>
      {/* touch joystick */}
      <div ref={jBase}
        onTouchStart={onJoy} onTouchMove={onJoy} onTouchEnd={endJoy}
        className="absolute bottom-6 left-6 rounded-full sm:hidden"
        style={{ width: 110, height: 110, background: "rgba(124,99,255,0.12)", border: "1px solid rgba(124,99,255,0.4)", touchAction: "none" }}>
        <div className="absolute left-1/2 top-1/2 rounded-full" style={{ transform: "translate(-50%,-50%)", width: 40, height: 40, background: "rgba(124,99,255,0.5)" }} />
      </div>
    </div>
  );
}
