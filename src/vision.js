// src/vision.js
//
// Tracing a floor-plan photo with Claude, on the USER'S OWN Anthropic API key.
// The browser calls api.anthropic.com directly (the SDK's dangerouslyAllowBrowser
// option sends Anthropic's CORS opt-in header). There is no server in the path:
// the key and the photo go from this device to Anthropic and nowhere else.

// The model the prompt below was tuned on. Each trace is billed to the user's key.
export const VISION_MODEL = "claude-sonnet-4-6";

// Furniture/fixture vocabulary the 3D renderer knows how to draw. Anything else -> "other".
export const FURN_TYPES = [
  "bed", "sofa", "armchair", "chair", "table", "coffee_table", "desk", "dresser",
  "nightstand", "wardrobe", "bookshelf", "tv", "toilet", "tub", "shower", "sink",
  "counter", "stove", "fridge", "rug", "other",
];

export function buildPrompt(width, height) {
  return `You vectorize ONE FLOOR of a house floor plan, often hand-drawn on graph/grid paper. The image is ${width}px wide, ${height}px tall. Origin top-left, x right, y down.
Return ONLY compact JSON, no markdown, no prose:
{"w":[[x1,y1,x2,y2,conf?]],"d":[[cx,cy,wpx]],"win":[[cx,cy,wpx]],"furn":[["type",cx,cy,wpx,hpx,deg]],"stairs":[[cx,cy,wpx,hpx,deg]],"scale":{"px":N,"unit":"ft","len":N},"rooms":[["Name",cx,cy]]}

CRITICAL — separate the BUILDING SHELL from its CONTENTS:
- The faint, evenly-spaced graph-paper grid is NOT walls. Ignore it completely. Only bold/dark pen strokes are real.
- WALLS are the structural lines that enclose rooms (exterior perimeter + interior partitions). Furniture, fixtures, appliances, and stair treads are NOT walls — never put them in "w".

- "w": structural walls only, each a straight segment [x1,y1,x2,y2] in pixels. Trace the full outer perimeter AND interior partition walls. Merge collinear runs; the drawing is on a grid so walls are almost always horizontal or vertical — snap them to exact right angles. You MAY append a 5th number conf (0–1) = how sure you are this is a real wall: omit it (or use 1) when confident; use a low value (~0.3) for faint, broken, smudged, ambiguous, or partly-guessed segments so the user knows to double-check them. Confidence never excludes a line — still include uncertain walls, just flag them with a low conf.
- "d": door openings as [centerX, centerY, approxWidthPx]. Doorways are gaps in a wall, often with a quarter-circle swing arc — the arc marks a door, not a wall.
- "win": window openings as [centerX, centerY, approxWidthPx]. Windows are usually thin double-lines or breaks drawn within an exterior wall.
- "furn": every piece of furniture/fixture/appliance, each as ["type", centerX, centerY, widthPx, heightPx, rotationDeg]. widthPx/heightPx are the bounding-box size in pixels (before rotation); rotationDeg is 0 if axis-aligned. "type" MUST be one of: ${FURN_TYPES.join(", ")} (use "other" if unsure). Common sketch cues: a rectangle with a curved pillow line = bed; an L or long block of cushions = sofa; small squares/diamonds by a sofa = armchair/chair; a rectangle ringed by small ovals = dining table+chairs; an oval/rounded-rectangle in a bathroom = tub; a U-shape or rounded form with a small tank = toilet; one or two ovals in a counter = sink(s); 4 small circles = stove burners; a long thin block along a wall = counter. Capture the cooktop, tubs, toilets, sinks, beds, sofas, chairs, tables, etc.
- "stairs": staircases as [centerX, centerY, widthPx, heightPx, rotationDeg]. A run of many short parallel lines = stairs; output ONE entry for the whole run (its bounding box), never individual treads, and never as walls.
- "scale": ONLY if real dimension/measure TEXT is legible (e.g. "12 ft"); pick one clear wall, give pixel length "px", real length "len", unit "ft" or "m". If there is no dimension text, return null (do NOT guess from the grid).
- "rooms": name each room at its center [["Name",cx,cy]]. Use any written labels; otherwise INFER the room from its furniture — toilet/tub/sink => "Bathroom", bed => "Bedroom", stove/cooktop => "Kitchen", dining table => "Dining", sofa/tv => "Living".

"furn", "stairs", and "rooms" may be []. Output JSON only.`;
}

// ---------- the user's key (stays on this device) ----------
// "Remember on this device" -> localStorage (survives restarts).
// Otherwise -> sessionStorage (gone when the tab closes).
const KEY_NAME = "bw_anthropic_key";
export function getKey() {
  try { return localStorage.getItem(KEY_NAME) || sessionStorage.getItem(KEY_NAME) || ""; } catch { return ""; }
}
export function keyIsRemembered() {
  try { return !!localStorage.getItem(KEY_NAME); } catch { return false; }
}
export function saveKey(key, remember) {
  forgetKey();
  try { (remember ? localStorage : sessionStorage).setItem(KEY_NAME, key.trim()); } catch {}
}
export function forgetKey() {
  try { localStorage.removeItem(KEY_NAME); sessionStorage.removeItem(KEY_NAME); } catch {}
}
// Anthropic API keys start with "sk-ant-". Catches pasting the wrong thing; the API is the real check.
export const looksLikeKey = (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test((k || "").trim());

// ---------- errors, in plain words ----------
// code -> what the user sees, and whether "Try again" makes sense.
export const TRACE_ERRORS = {
  nokey:      { retry: false, msg: "Add your Anthropic API key to trace a photo, or draw the walls yourself." },
  badkey:     { retry: false, msg: "Anthropic didn't accept that API key. Check it was copied in full, or make a new one." },
  nocredit:   { retry: false, msg: "Your Anthropic account is out of credit. Add credit in the Anthropic Console, then try again." },
  permission: { retry: false, msg: "That API key isn't allowed to use this model. Check the key's workspace settings in the Anthropic Console." },
  busy:       { retry: true,  msg: "Claude is busy right now. Your photo is fine. Try again in a minute, or draw the walls yourself." },
  offline:    { retry: true,  msg: "We couldn't reach Anthropic. Check your internet connection, then try again." },
  toolong:    { retry: true,  msg: "This plan was too big to read in one go. Try a photo of one floor, or draw the rest by hand." },
  unreadable: { retry: true,  msg: "We couldn't find a floor plan in that picture. Try a clearer photo, or draw the walls yourself." },
};
export class TraceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function classify(err, A) {
  if (err instanceof TraceError) return err.code;
  if (err instanceof A.AuthenticationError) return "badkey";
  if (err instanceof A.PermissionDeniedError) return "permission";
  if (err instanceof A.RateLimitError || err instanceof A.InternalServerError) return "busy";
  if (err instanceof A.APIConnectionTimeoutError) return "busy";
  if (err instanceof A.APIConnectionError) return "offline";
  if (err instanceof A.APIError) {
    const msg = String(err.message || "");
    if (err.status === 402 || err.type === "billing_error" || /credit balance/i.test(msg)) return "nocredit";
    if (err.status === 529 || err.type === "overloaded_error") return "busy";
  }
  return "unreadable";
}

// ---------- the call ----------
// Returns the raw plan JSON { w, d, win, furn, stairs, scale, rooms }.
// Throws TraceError(code) with a code from TRACE_ERRORS.
export async function traceWithClaude({ apiKey, base64, width, height }) {
  if (!apiKey) throw new TraceError("nokey");
  // Loaded on first use, so people who only draw never download the SDK.
  const { default: Anthropic, ...A } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 90_000 });
  let res;
  try {
    res = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
        { type: "text", text: buildPrompt(width, height) },
      ]}],
    });
  } catch (err) {
    throw new TraceError(classify(err, A));
  }
  if (res.stop_reason === "max_tokens") throw new TraceError("toolong");
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new TraceError("unreadable");
  try { return JSON.parse(clean.slice(s, e + 1)); } catch { throw new TraceError("unreadable"); }
}
