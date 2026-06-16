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

function buildPrompt(width, height) {
  return `You vectorize house floor plans (often hand-drawn). The image is ${width}px wide, ${height}px tall. Origin top-left, x right, y down.
Return ONLY compact JSON, no markdown, no prose:
{"w":[[x1,y1,x2,y2]],"d":[[cx,cy,wpx]],"win":[[cx,cy,wpx]],"scale":{"px":N,"unit":"ft","len":N},"rooms":[["Name",cx,cy]]}
Rules:
- "w": every wall as a straight segment between two endpoints, in pixels. Trace the full outer perimeter AND all interior walls. Merge collinear runs; snap to right angles where the drawing intends them.
- "d": door openings as [centerX, centerY, approxWidthPx].
- "win": window openings as [centerX, centerY, approxWidthPx].
- "scale": if any dimension/measure text is legible, pick ONE clear wall, give its pixel length "px", real length "len", and "unit" ("ft" or "m"). Otherwise null.
- "rooms": legible room labels with center point, else [].
Output JSON only.`;
}

async function callAnthropic(imageBase64, mediaType, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("missing ANTHROPIC_API_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
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
