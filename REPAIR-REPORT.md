# SUBTEXT — Production Rescue Report

## 1. Setup Instructions

### Prerequisites

- Node.js 18+ (`node --version`)
- An Anthropic API key (`sk-ant-...`)

### Quickstart

```bash
# 1. Put all three files in the same folder:
#      server.js
#      subtext-fixed.html
#      package.json

# 2. No npm install needed — zero dependencies, stdlib only.

# 3. Start the server:
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE node server.js

# 4. Open in browser:
open http://localhost:3000
```

### Verify it's working

```bash
curl http://localhost:3000/health
# → {"ok":true,"timestamp":"...","apiKey":"set"}
```

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Starts with `sk-ant-` |
| `PORT` | No | `3000` | Any available port |
| `ALLOWED_ORIGIN` | No | `*` | Tighten to your domain in production |

---

## 2. Exact Bug List

### server.js — 4 bugs (2 fatal)

#### Bug 1 — FATAL: Entire file duplicated → SyntaxError on load

**Root cause:** The file contained two complete, identical copies of the server — lines 1–502 and lines 503–1042. Every `const` declaration appeared twice in the same module scope:

```
const http, const https, const url, const PORT, const ANTHROPIC_KEY,
const ALLOWED_ORIGIN, const MODEL_FAST, const MODEL_SONNET, const rateMap,
const RATE_WINDOW_MS, const RATE_MAX_REQ, const AGENT_PROMPTS,
const SYNTHESIZER_SYSTEM, const server
```

Node.js's parser throws `SyntaxError: Identifier 'http' has already been declared` before executing a single line. The server **could not start at all** — not even to print an error message.

**Fix:** Removed the duplicate. The file is now 592 lines (down from 1042). Every declaration appears exactly once.

---

#### Bug 2 — FATAL: GET `/` route was outside the request handler

**Root cause:** Lines 1007–1023 of the original read:

```javascript
if (req.method === 'GET' && parsed.pathname === '/') {
  const fs = require('fs');
  fs.readFile(htmlPath, 'utf8', (err, html) => { ... });
  return;
}
```

This code was at **module top level** — not inside the `http.createServer(async (req, res) => { ... })` callback. The variables `req` and `parsed` do not exist at module scope. If Bug 1 weren't there, this would throw `ReferenceError: req is not defined` on module load.

Even if both bugs were absent, visiting `http://localhost:3000/` would return 404 because the working request handler had no `GET /` route.

**Fix:** The `GET /` route is now correctly placed inside the `http.createServer` callback, before the 404 catch-all.

---

#### Bug 3 — Wrong Sonnet model name → all synthesis calls fail

**Root cause:**
```javascript
const MODEL_SONNET = 'claude-sonnet-4-20250514'; // does not exist
```

The correct identifier is `claude-sonnet-4-6`. Every synthesis call returned HTTP 400 from Anthropic with `model_not_found`.

**Fix:**
```javascript
const MODEL_SONNET = 'claude-sonnet-4-6';
```

---

#### Bug 4 — `server.listen` appeared after orphaned code

**Root cause:** The `server.listen()` call (line 1025) appeared after the orphaned `GET /` block (lines 1007–1023). Structurally this meant the second copy of the server "started" without the first copy ever listening. Combined with Bug 1 (SyntaxError) this was moot, but it indicated the file was structurally incoherent.

**Fix:** `server.listen` is now the last statement in the file, after `http.createServer`.

---

### subtext-fixed.html — 4 bugs

#### Bug 5 — Refine button permanently disabled after one successful refinement

**Root cause:** In `refineAnalysis()`, `btn.disabled = false` and `status.classList.remove('show')` were only called inside the `catch` block. The success path never reset them. After a single successful refinement, the "Refine the analysis →" button was permanently disabled for the session.

**Fix:** Added both reset calls to the success path, after `window.scrollTo`.

---

#### Bug 6 — XSS vector: AI script content injected into onclick attribute

**Root cause:**
```javascript
const escapedScript = (s.script||'').replace(/'/g,"\\'").replace(/\n/g,' ');
html += `<button onclick="copyScript(this,'${escapedScript}')">Copy</button>`;
```

Only single quotes and newlines were escaped. A response containing `\` followed by `'` produces `\\'`, leaving an unescaped quote character that breaks out of the onclick string context. More fundamentally: placing AI-generated text inside `onclick="..."` HTML is structurally unsafe regardless of escaping — the attack surface scales with every escape bypass discovered in the model's output format.

**Fix:** AI script content is stored in a module-level `scriptStore` map. The onclick passes only a numeric index:
```javascript
scriptStore[i] = s.script || '';
html += `<button onclick="copyScript(this,${i})">Copy</button>`;

function copyScript(btn, scriptIndex) {
  const scriptText = scriptStore[scriptIndex] || '';
  navigator.clipboard.writeText(scriptText)...
}
```

---

#### Bug 7 — XSS vector: AI share content injected into onclick attribute

**Root cause:**
```javascript
html += `<button onclick="openShareCard('${escapeStr(synthesis.shareableInsight)}')">`;
```

Same structural problem as Bug 6, with a slightly stronger escape function (`escapeStr` also handled `\` and `"`), but still fundamentally vulnerable.

**Fix:** AI insight stored in `shareInsight` module variable. onclick takes no args:
```javascript
shareInsight = synthesis.shareableInsight;
html += `<button onclick="openShareCard()">...`;

function openShareCard() {
  document.getElementById('sc-quote-txt').textContent = shareInsight;
  ...
}
```

---

#### Bug 8 — Refine spinner "Refining…" never cleared on success (same root as Bug 5)

**Root cause:** `status.classList.remove('show')` was only in the catch block. The spinner remained visible after a successful refinement.

**Fix:** Addressed with the same change as Bug 5.

---

## 3. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Anthropic rate limit (429) under heavy use | High | High | Sequential frontend pipeline (1.2 s between agents) already prevents runaway fanout. Backend returns structured 429 with user message. No auto-retry anywhere. |
| R2 | Concurrent users competing for the same Anthropic rate limit | Medium | High | The sequential design is per-session. Multiple simultaneous users can still exceed the rate limit. Add a server-side queue or per-key concurrency limit for multi-user deployment. |
| R3 | No authentication on /api/analyze | High | High | Any client that can reach the endpoint can bill your API key. Add a shared secret header or session token before public deployment. |
| R4 | Large PDF/image payloads (10–30 MB) pass through Node.js memory | Medium | Medium | 50 MB body limit is set. Monitor Node heap under load. For production, route image uploads directly to Anthropic via signed URLs. |
| R5 | Synthesis JSON parse failure for long conversations | Medium | Low | Fallback result is returned (HTTP 200 with `_synthesisFallback: true`). Individual agent outputs are still shown. |
| R6 | OCR text edits are in-memory only | High | Low | A page refresh discards user edits to extracted text. Consider `localStorage` persistence if OCR correction is important. |
| R7 | rateMap grows without bounds over time | Low | Low | Old IP entries are never pruned. Under extreme load, the Map can grow large. Add a periodic cleanup: `setInterval(() => { for (const [ip, e] of rateMap) { if (Date.now() - e.windowStart > RATE_WINDOW_MS * 2) rateMap.delete(ip); } }, 60_000)`. |
| R8 | server.on('error') exits the process | Medium | Medium | Correct for fatal startup errors (EADDRINUSE). For production, use a process manager (pm2, systemd) that auto-restarts. |

---

## 4. Production Recommendations

### Minimum before exposing to the internet

1. **Add authentication.** At minimum, a shared secret in the request header:
   ```javascript
   // In server.js, add to POST /api/analyze guard:
   const clientSecret = req.headers['x-subtext-secret'];
   if (clientSecret !== process.env.API_SECRET) {
     return jsonResponse(res, 401, { error: 'Unauthorized' });
   }
   ```
   Set `x-subtext-secret` in the frontend's fetch calls.

2. **Tighten CORS.** Set `ALLOWED_ORIGIN` to your specific domain:
   ```
   ALLOWED_ORIGIN=https://yourapp.com node server.js
   ```

3. **Use a process manager:**
   ```bash
   npm install -g pm2
   pm2 start server.js --name subtext --env production
   pm2 save
   ```

4. **Set up HTTPS.** Run behind nginx or a load balancer that terminates TLS. Never expose plain HTTP in production.

### For multi-user scale

5. **Add a server-side request queue.** Current design: each frontend session makes sequential API calls. Two simultaneous users = 2× serial calls = rate limit hit at ~5 concurrent users. Add a Bottleneck or PQueue wrapper around `anthropicRequest`.

6. **Move image/PDF data out of the request body.** Upload directly to S3 or similar and pass a URL to the backend. This prevents large base64 payloads from exhausting Node.js memory.

7. **Add structured logging.** Replace `console.log` with a proper logger (pino, winston) that supports log levels and JSON format for ingestion into Datadog/CloudWatch.

8. **Add request IDs.** Attach a UUID to each incoming request and thread it through all log lines. Makes debugging parallel sessions tractable.

---

## 5. Debugging Checklist

### "Server won't start"

```bash
node --check server.js        # Check for syntax errors
node server.js 2>&1 | head    # Look at the actual error
lsof -i :3000                 # Port already in use?
echo $ANTHROPIC_API_KEY       # Key set in this shell?
```

### "GET / returns 404"

- Confirm `subtext-fixed.html` is in the **same directory** as `server.js`
- Check `ls -la` — file must be named exactly `subtext-fixed.html`
- Check server console — it logs `[GET /] Could not read subtext-fixed.html:` if the file is missing

### "Analysis fails with 'Rate limit reached'"

- Wait 60 seconds and retry (server-side window)
- If persistent: check your Anthropic account for per-minute token limits
- The sequential pipeline spaces calls 1.2 s apart; under heavy use reduce that to 2 s

### "Synthesis returns empty/fallback report"

- Check server console for `[Synthesizer] All parse strategies failed`
- The raw Anthropic response is logged — inspect it for truncation or format issues
- The conversation may be very long — truncation is at 8,000 chars for synthesis input; test with a shorter excerpt
- If `MODEL_SONNET` returns 400: re-check the model name is `claude-sonnet-4-6`

### "OCR always returns 'No readable text found'"

- Verify the image is clear and not heavily compressed
- Test the `/health` endpoint first — if API key is missing, OCR will silently fail
- Check server console for `[OCR] Anthropic error:` lines

### "CORS errors in browser console"

- Confirm the server is running on the same origin the frontend is served from
- If running frontend from `file://`, set `ALLOWED_ORIGIN=*` (default) and confirm no browser extension is blocking mixed content

### Quick sanity test (no browser needed)

```bash
# Health check
curl -s http://localhost:3000/health | python3 -m json.tool

# OCR (replace DATA with a small base64 JPEG)
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"mode":"ocr","images":[{"type":"image","mediaType":"image/jpeg","data":"SMALL_BASE64_HERE"}]}' \
  | python3 -m json.tool

# Agent (quick test)
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"mode":"analysis","subMode":"agent","agentName":"tone","transcript":"Me: Are you okay?\nThem: Fine.","contextType":"relationship","context":""}' \
  | python3 -m json.tool
```
