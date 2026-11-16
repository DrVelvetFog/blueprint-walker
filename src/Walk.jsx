import React, { useState, useRef, useEffect } from "react";
import * as THREE from "three";
import { DOOR_TOP_M, EYE_M, FT_TO_M, FURN_3D, WALL_T_M, WIN_SILL_M, WIN_TOP_M, pointSeg } from "./shared.js";

// ================= 3D WALK =================
export default function Walk({ walls, openings, furniture = [], stairs = [], rooms = [], scale, ceiling, onExit }) {
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
