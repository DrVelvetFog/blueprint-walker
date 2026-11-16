import React, { useState, useRef, useEffect } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DOOR_TOP_M, EYE_M, FT_TO_M, FURN_3D, WALL_T_M, WIN_SILL_M, WIN_TOP_M, pointSeg, IS_TOUCH } from "./shared.js";

// ================= 3D WALK =================
// Three ways to look at the plan:
//   walk      — first person, with collision (WASD + mouse, or two touch joysticks)
//   dollhouse — the whole home from above at an angle, ceiling off (drag to turn, scroll/pinch to zoom)
//   top       — straight down, like the plan but in 3D
const VIEWS = [["walk", "Walk"], ["dollhouse", "Dollhouse"], ["top", "Top"]];

// do segments p1→p2 and p3→p4 cross? (x/z plane)
function crosses(p1x, p1z, p2x, p2z, p3x, p3z, p4x, p4z) {
  const d = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = d(p3x, p3z, p4x, p4z, p1x, p1z), d2 = d(p3x, p3z, p4x, p4z, p2x, p2z);
  const d3 = d(p1x, p1z, p2x, p2z, p3x, p3z), d4 = d(p1x, p1z, p2x, p2z, p4x, p4z);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export default function Walk({ walls, openings, furniture = [], stairs = [], rooms = [], scale, ceiling, onExit }) {
  const mountRef = useRef(null);
  const miniRef = useRef(null);
  const apiRef = useRef({});                 // setView / goTo / photo, filled in by the scene effect
  const [locked, setLocked] = useState(false);
  const [view, setView] = useState("walk");
  const [here, setHere] = useState("");      // name of the room you're standing in
  const touchMove = useRef({ x: 0, y: 0 });  // left stick → move (read in tick)
  const lookMove = useRef({ x: 0, y: 0 });   // right stick → look (read in tick)
  const named = rooms.filter((r) => r.name);

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
    const camera = new THREE.PerspectiveCamera(72, W / H, 0.05, 400);
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

    // ceiling over the footprint, so looking up in the walk shows a ceiling, not the void.
    // Hidden in the dollhouse and top views.
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(fw - 4, fh - 4),
      new THREE.MeshBasicMaterial({ color: 0x8f89aa, side: THREE.DoubleSide })); // unlit: nothing lights a ceiling from below
    ceil.rotation.x = Math.PI / 2; ceil.position.y = ceilingM; scene.add(ceil);

    // "you are here" marker for the dollhouse and top views
    const marker = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 20), new THREE.MeshStandardMaterial({ color: 0x7cffcb, emissive: 0x1d6b55 }));
    marker.rotation.x = Math.PI; marker.visible = false; scene.add(marker);

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

    // how far you can see from (x,z) toward angle a, before a wall (capped)
    const MAXRAY = 30;
    function rayLen(x, z, a) {
      const dx = Math.sin(a), dz = Math.cos(a);
      let best = MAXRAY;
      for (const s of collide) {
        const ex = s.bx - s.ax, ez = s.bz - s.az, den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((s.ax - x) * ez - (s.az - z) * ex) / den;      // along the ray
        const u = ((s.ax - x) * dz - (s.az - z) * dx) / den;      // along the wall
        if (t > 0.05 && u >= 0 && u <= 1 && t < best) best = t;
      }
      return best;
    }
    // the most open direction from a point, and how open the spot is overall
    function openness(x, z) {
      let total = 0, bestA = 0, bestL = -1;
      for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2, L = rayLen(x, z, a); total += Math.min(L, 8); if (L > bestL) { bestL = L; bestA = a; } }
      return { total, bestA };
    }
    // face direction a (x = sin a, z = cos a); the camera looks down -Z at yaw 0
    const yawFor = (a) => Math.atan2(-Math.sin(a), -Math.cos(a));

    let yaw = 0, pitch = 0;
    // stand near the back of the space around (x,z), looking across it toward the most open direction
    function placeAt(x, z) {
      const [lx, lz] = resolve(x, z);
      const a = openness(lx, lz).bestA;
      const back = Math.max(0, Math.min(2.5, rayLen(lx, lz, a + Math.PI) - 0.5));
      const [px, pz] = resolve(lx - Math.sin(a) * back, lz - Math.cos(a) * back);
      camera.position.set(px, EYE_M, pz);
      yaw = yawFor(a); pitch = -0.08;
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    }

    // spawn: the roomiest of the room labels (or the middle), facing the longest clear view
    {
      const spots = [[0, 0], ...rooms.filter((r) => r.name).map((r) => W2(r.x, r.y))];
      let best = spots[0], bestT = -1;
      for (const [x, z] of spots) { const [rx, rz] = resolve(x, z), o = openness(rx, rz); if (o.total > bestT) { bestT = o.total; best = [rx, rz]; } }
      placeAt(best[0], best[1]);
    }

    // ---- which room am I in? the nearest label I can see (no wall in between) ----
    const roomPts = rooms.filter((r) => r.name).map((r) => { const [x, z] = W2(r.x, r.y); return { name: r.name, x, z }; });
    function currentRoom() {
      const { x, z } = camera.position;
      let best = "", bd = 1e9;
      for (const r of roomPts) {
        const d = Math.hypot(r.x - x, r.z - z);
        if (d >= bd) continue;
        if (collide.some((s) => crosses(x, z, r.x, r.z, s.ax, s.az, s.bx, s.bz))) continue;
        bd = d; best = r.name;
      }
      return best;
    }

    // ---- views ----
    const span = Math.max(fw, fh, 6);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enabled = false; orbit.enableDamping = true; orbit.target.set(0, 0, 0);
    orbit.minDistance = 2; orbit.maxDistance = span * 3;
    let mode = "walk";
    const walker = { x: camera.position.x, z: camera.position.z, yaw, pitch };
    function setMode(m) {
      if (m === mode) return;
      if (mode === "walk") Object.assign(walker, { x: camera.position.x, z: camera.position.z, yaw, pitch });
      mode = m;
      if (document.pointerLockElement) document.exitPointerLock();
      const walking = m === "walk";
      ceil.visible = walking; marker.visible = !walking;
      scene.traverse((o) => {          // room names: readable from above
        if (!o.isSprite) return;
        o.userData.base ||= o.scale.clone();
        o.scale.copy(o.userData.base).multiplyScalar(walking ? 1 : 2.6);
      });
      scene.fog.near = walking ? 8 : 400; scene.fog.far = walking ? 60 : 800;
      orbit.enabled = !walking;
      if (walking) {
        camera.position.set(walker.x, EYE_M, walker.z);
        yaw = walker.yaw; pitch = walker.pitch;
        camera.rotation.set(pitch, yaw, 0, "YXZ");
      } else {
        marker.position.set(walker.x, ceilingM * 0.5 + 0.35, walker.z);
        orbit.target.set(0, 0, 0);
        if (m === "top") {
          orbit.minPolarAngle = 0; orbit.maxPolarAngle = 0;
          camera.position.set(0, span * 1.15, 0.001);
        } else {
          orbit.minPolarAngle = 0.15; orbit.maxPolarAngle = 1.3;
          camera.position.set(span * 0.42, span * 0.62, span * 0.58);
        }
        orbit.update();
      }
      setView(m);
    }

    // ---- photo of the current view ----
    function photo() {
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL("image/png");
      const a = document.createElement("a");
      const where = mode === "walk" ? (currentRoom() || "inside") : mode;
      a.href = url; a.download = `blueprint-walker-${where.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    }

    // ---- jump to a room ----
    function goTo(name) {
      const r = roomPts.find((q) => q.name === name);
      if (!r) return;
      if (mode !== "walk") setMode("walk");
      placeAt(r.x, r.z);
    }
    apiRef.current = { setMode, photo, goTo };

    // ---- input ----
    const keys = {};
    const kd = (e) => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      keys[e.code] = true;
      if (e.code === "Digit1") setMode("walk");
      else if (e.code === "Digit2") setMode("dollhouse");
      else if (e.code === "Digit3") setMode("top");
      else if (e.code === "KeyP") photo();
    };
    const ku = (e) => { keys[e.code] = false; };
    window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);

    const onMouse = (e) => {
      if (mode !== "walk" || document.pointerLockElement !== renderer.domElement) return;
      yaw -= e.movementX * 0.0024; pitch -= e.movementY * 0.0024;
      pitch = Math.max(-1.45, Math.min(1.45, pitch));
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    };
    document.addEventListener("mousemove", onMouse);
    const clickLock = () => { if (mode === "walk" && !IS_TOUCH) renderer.domElement.requestPointerLock?.(); };
    renderer.domElement.addEventListener("click", clickLock);
    const onLockChange = () => setLocked(document.pointerLockElement === renderer.domElement);
    document.addEventListener("pointerlockchange", onLockChange);

    // ---- minimap ----
    const mini = miniRef.current;
    const mctx = mini?.getContext("2d");
    const MS = 150, MPAD = 10;
    if (mini) { mini.width = MS; mini.height = MS; }
    const msc = (MS - MPAD * 2) / Math.max((maxx - minx) * mPerPx, (maxy - miny) * mPerPx, 1);
    const MP = (x, z) => [MS / 2 + x * msc, MS / 2 + z * msc];
    function minimap() {
      if (!mctx) return;
      mctx.clearRect(0, 0, MS, MS);
      mctx.fillStyle = "rgba(12,10,31,0.7)"; mctx.fillRect(0, 0, MS, MS);
      mctx.strokeStyle = "#8b78ff"; mctx.lineWidth = 1.5;
      collide.forEach((c) => { const [x1, y1] = MP(c.ax, c.az), [x2, y2] = MP(c.bx, c.bz); mctx.beginPath(); mctx.moveTo(x1, y1); mctx.lineTo(x2, y2); mctx.stroke(); });
      const px = mode === "walk" ? camera.position.x : walker.x, pz = mode === "walk" ? camera.position.z : walker.z;
      const py = mode === "walk" ? yaw : walker.yaw;
      const [pxp, pzp] = MP(px, pz);
      mctx.fillStyle = "#7CFFCB"; mctx.beginPath(); mctx.arc(pxp, pzp, 3.5, 0, 7); mctx.fill();
      mctx.strokeStyle = "#7CFFCB"; mctx.beginPath(); mctx.moveTo(pxp, pzp);
      mctx.lineTo(pxp + Math.sin(py) * -10, pzp + Math.cos(py) * -10); mctx.stroke();
    }

    // ---- loop ----
    const up = new THREE.Vector3(0, 1, 0);
    const clock = new THREE.Clock();
    let raf, lastRoom = null, roomTimer = 0, miniTimer = 0;
    function tick() {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      if (mode === "walk") {
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
        // room name: a few times a second is plenty
        roomTimer += dt;
        if (roomTimer > 0.25) { roomTimer = 0; const r = currentRoom(); if (r !== lastRoom) { lastRoom = r; setHere(r); } }
      } else {
        orbit.update();
      }
      // the minimap only needs ~15 fps
      miniTimer += dt;
      if (miniTimer > 0.066) { miniTimer = 0; minimap(); }
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
      orbit.dispose();
      // free everything the scene made, and give the WebGL context back to the browser,
      // so going back and forth between editing and walking can't run phones out of contexts
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        ms.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
      });
      renderer.dispose();
      renderer.forceContextLoss();
      mount.removeChild(renderer.domElement);
      apiRef.current = {};
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

  const walking = view === "walk";
  const chip = { background: "rgba(20,16,46,0.82)", border: "1px solid rgba(255,255,255,0.16)" };
  const hint = !walking
    ? (IS_TOUCH ? "Drag to turn · pinch to zoom · two fingers to slide" : "Drag to turn · scroll to zoom · right-drag to slide · 1 walk · 2 dollhouse · 3 top")
    : (IS_TOUCH ? "Left stick walks · right stick looks around" : "Click to look · W A S D walk · Shift run · Esc release · 1 2 3 views · P photo");

  return (
    <div className="fixed inset-0 z-40" style={{ background: "#0c0a1f", touchAction: "none", overscrollBehavior: "none" }}>
      <div ref={mountRef} className="absolute inset-0" />
      {/* crosshair */}
      {walking && <div className="absolute left-1/2 top-1/2 pointer-events-none" style={{ transform: "translate(-50%,-50%)", width: 6, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.7)" }} />}

      {/* top-left controls */}
      <div className="absolute top-3 left-3 right-[132px] sm:right-[172px] flex flex-col items-start gap-2" style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}>
        <button onClick={onExit} className="min-h-10 pointer-coarse:min-h-11 px-3 rounded-lg text-sm text-slate-200" style={chip}>← Edit plan</button>
        <div role="radiogroup" aria-label="View" className="flex rounded-lg overflow-hidden" style={chip}>
          {VIEWS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={view === k} onClick={() => apiRef.current.setMode?.(k)}
              className="min-h-10 pointer-coarse:min-h-11 px-3 text-sm"
              style={{ background: view === k ? "#6d5ae6" : "transparent", color: view === k ? "#fff" : "#cbd5e1" }}>{label}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {named.length > 0 && (
            <label className="relative">
              <span className="sr-only">Go to a room</span>
              <select value="" onChange={(e) => { if (e.target.value) apiRef.current.goTo?.(e.target.value); e.target.blur(); }}
                className="min-h-10 pointer-coarse:min-h-11 pl-3 pr-8 rounded-lg text-sm text-slate-200 appearance-none" style={chip}>
                <option value="">Go to a room…</option>
                {[...new Set(named.map((r) => r.name))].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none" aria-hidden="true">▾</span>
            </label>
          )}
          <button onClick={() => apiRef.current.photo?.()} title="Save a picture of this view (P)" className="min-h-10 pointer-coarse:min-h-11 px-3 rounded-lg text-sm text-slate-200" style={chip}>📷 Photo</button>
        </div>
      </div>

      {/* minimap + where you are */}
      <div className="absolute right-3 flex flex-col items-end gap-1.5" style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}>
        <canvas ref={miniRef} className="rounded-lg w-[110px] h-[110px] sm:w-[150px] sm:h-[150px]" style={{ border: "1px solid rgba(255,255,255,0.15)" }} aria-label="Map of the plan" />
        {walking && here && <div aria-live="polite" className="px-2 py-1 rounded-md text-xs text-slate-100" style={chip}>You're in: {here}</div>}
      </div>

      {/* desktop: how to start looking around */}
      {walking && !locked && !IS_TOUCH && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-6">
          <div className="px-4 py-2.5 rounded-lg text-sm text-slate-200 text-center" style={chip}>
            Click to look around · <b>W A S D</b> move · <b>Shift</b> run · <b>Esc</b> release
          </div>
        </div>
      )}

      {/* key / gesture hints (desktop walk shows them in the centre box until you click) */}
      {!(walking && !locked && !IS_TOUCH) && <div className="absolute left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs text-slate-300 text-center pointer-events-none max-w-[92vw]"
        style={{ ...chip, bottom: walking && IS_TOUCH ? "calc(env(safe-area-inset-bottom, 0px) + 168px)" : "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}>
        {hint}
      </div>}

      {/* twin touch joysticks (any touch screen, walk view only): left = move, right = look */}
      {walking && IS_TOUCH && <Stick label="move" baseRef={moveBase} nubRef={moveNub} onTouch={onMoveStick} side="left" />}
      {walking && IS_TOUCH && <Stick label="look" baseRef={lookBase} nubRef={lookNub} onTouch={onLookStick} side="right" />}
    </div>
  );
}

// One on-screen joystick, pinned above the home-indicator safe area.
function Stick({ label, baseRef, nubRef, onTouch, side }) {
  return (
    <div ref={baseRef}
      onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={onTouch} onTouchCancel={onTouch}
      className={`absolute rounded-full ${side === "left" ? "left-6" : "right-6"}`}
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 28px)", width: 120, height: 120, background: "rgba(124,99,255,0.12)", border: "1px solid rgba(124,99,255,0.4)", touchAction: "none" }}>
      <div ref={nubRef} className="absolute left-1/2 top-1/2 rounded-full" style={{ transform: "translate(-50%,-50%)", width: 46, height: 46, background: "rgba(124,99,255,0.55)" }} />
      <span className="absolute left-1/2 rounded text-[10px] uppercase tracking-wide text-slate-300 pointer-events-none" style={{ transform: "translateX(-50%)", bottom: -18 }}>{label}</span>
    </div>
  );
}
