// netlify/functions/extract-plan.mjs
//
// Key-safe vision proxy with a swappable backend. The browser sends the image here;
// THIS code (server-side, never in the browser) does the vision call and returns the plan JSON.
//
// Choose the backend with the VISION_BACKEND env var:
//   VISION_BACKEND=anthropic   -> Claude (default). Works deployed on Netlify, anywhere. Needs ANTHROPIC_API_KEY.
//   VISION_BACKEND=ollama      -> local Ollama. ONLY works where this function can reach Ollama
//                                 (i.e. `netlify dev` on a machine running Ollama, or via OLLAMA_HOST tunnel).
//
// Env vars:
//   ANTHROPIC_API_KEY   the secret key (anthropic backend only) — never goes to the client
//   VISION_BACKEND      "anthropic" | "ollama"   (default "anthropic")
//   OLLAMA_HOST         default "http://localhost:11434"
//   OLLAMA_MODEL        default "qwen2.5vl:7b"   (try llama3.2-vision:11b for dimension text)
//
// Client call (same-origin, no CORS):
//   const base64 = img.url.split(",")[1];
//   const res = await fetch("/.netlify/functions/extract-plan", {
//     method: "POST", headers: { "content-type": "application/json" },
//     body: JSON.stringify({ imageBase64: base64, mediaType: "image/jpeg", width: img.w, height: img.h }),
//   });
//   const plan = await res.json();   // -> { w, d, win, scale, rooms }

// Furniture/fixture vocabulary the 3D renderer knows how to draw. Anything else -> "other".
const FURN_TYPES = [
  "bed", "sofa", "armchair", "chair", "table", "coffee_table", "desk", "dresser",
  "nightstand", "wardrobe", "bookshelf", "tv", "toilet", "tub", "shower", "sink",
  "counter", "stove", "fridge", "rug", "other",
];

function buildPrompt(width, height) {
  return `You vectorize ONE FLOOR of a house floor plan, often hand-drawn on graph/grid paper. The image is ${width}px wide, ${height}px tall. Origin top-left, x right, y down.
Return ONLY compact JSON, no markdown, no prose:
{"w":[[x1,y1,x2,y2]],"d":[[cx,cy,wpx]],"win":[[cx,cy,wpx]],"furn":[["type",cx,cy,wpx,hpx,deg]],"stairs":[[cx,cy,wpx,hpx,deg]],"scale":{"px":N,"unit":"ft","len":N},"rooms":[["Name",cx,cy]]}

CRITICAL — separate the BUILDING SHELL from its CONTENTS:
- The faint, evenly-spaced graph-paper grid is NOT walls. Ignore it completely. Only bold/dark pen strokes are real.
- WALLS are the structural lines that enclose rooms (exterior perimeter + interior partitions). Furniture, fixtures, appliances, and stair treads are NOT walls — never put them in "w".

- "w": structural walls only, each a straight segment [x1,y1,x2,y2] in pixels. Trace the full outer perimeter AND interior partition walls. Merge collinear runs; the drawing is on a grid so walls are almost always horizontal or vertical — snap them to exact right angles.
- "d": door openings as [centerX, centerY, approxWidthPx]. Doorways are gaps in a wall, often with a quarter-circle swing arc — the arc marks a door, not a wall.
- "win": window openings as [centerX, centerY, approxWidthPx]. Windows are usually thin double-lines or breaks drawn within an exterior wall.
- "furn": every piece of furniture/fixture/appliance, each as ["type", centerX, centerY, widthPx, heightPx, rotationDeg]. widthPx/heightPx are the bounding-box size in pixels (before rotation); rotationDeg is 0 if axis-aligned. "type" MUST be one of: ${FURN_TYPES.join(", ")} (use "other" if unsure). Common sketch cues: a rectangle with a curved pillow line = bed; an L or long block of cushions = sofa; small squares/diamonds by a sofa = armchair/chair; a rectangle ringed by small ovals = dining table+chairs; an oval/rounded-rectangle in a bathroom = tub; a U-shape or rounded form with a small tank = toilet; one or two ovals in a counter = sink(s); 4 small circles = stove burners; a long thin block along a wall = counter. Capture the cooktop, tubs, toilets, sinks, beds, sofas, chairs, tables, etc.
- "stairs": staircases as [centerX, centerY, widthPx, heightPx, rotationDeg]. A run of many short parallel lines = stairs; output ONE entry for the whole run (its bounding box), never individual treads, and never as walls.
- "scale": ONLY if real dimension/measure TEXT is legible (e.g. "12 ft"); pick one clear wall, give pixel length "px", real length "len", unit "ft" or "m". If there is no dimension text, return null (do NOT guess from the grid).
- "rooms": name each room at its center [["Name",cx,cy]]. Use any written labels; otherwise INFER the room from its furniture — toilet/tub/sink => "Bathroom", bed => "Bedroom", stove/cooktop => "Kitchen", dining table => "Dining", sofa/tv => "Living".

"furn", "stairs", and "rooms" may be []. Output JSON only.`;
}

async function callAnthropic(imageBase64, mediaType, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("missing ANTHROPIC_API_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: prompt },
      ]}],
    }),
  });
  if (!r.ok) throw new Error("anthropic " + r.status + " " + (await r.text()).slice(0, 200));
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function callOllama(imageBase64, prompt) {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "qwen2.5vl:7b";
  const r = await fetch(host + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",                 // constrain output to valid JSON
      options: { temperature: 0 },
      messages: [{ role: "user", content: prompt, images: [imageBase64] }],
    }),
  });
  if (!r.ok) throw new Error("ollama " + r.status + " " + (await r.text()).slice(0, 200));
  const data = await r.json();
  return data?.message?.content || "";
}

export default async (req) => {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "We couldn't read that request." }, 400); }

  const { imageBase64, mediaType = "image/jpeg", width, height } = body || {};
  if (!imageBase64 || !width || !height)
    return json({ error: "No image came through. Try taking the photo again." }, 400);

  const backend = (process.env.VISION_BACKEND || "anthropic").toLowerCase();
  const prompt = buildPrompt(width, height);

  try {
    const text = backend === "ollama"
      ? await callOllama(imageBase64, prompt)
      : await callAnthropic(imageBase64, mediaType, prompt);

    let clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    if (s < 0 || e < 0) return json({ error: "Couldn't read the plan automatically." }, 502);

    const plan = JSON.parse(clean.slice(s, e + 1));
    return json(plan, 200);
  } catch (err) {
    return json({ error: "The plan reader is having trouble right now.", detail: String(err).slice(0, 200) }, 502);
  }
};
