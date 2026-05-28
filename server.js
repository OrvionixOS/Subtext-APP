/**
 * SUBTEXT — Backend API Server  (production-hardened, single-copy)
 * ─────────────────────────────────────────────────────────────────
 * All Anthropic calls are server-side only.
 * Frontend NEVER touches api.anthropic.com directly.
 *
 * Routes:
 *   GET  /                — serves subtext-fixed.html
 *   GET  /health          — JSON health check
 *   POST /api/analyze     — OCR + agent analysis + synthesis
 *
 * POST /api/analyze payload shapes:
 *   { mode: 'ocr',      images: [{type, mediaType, data}] }
 *   { mode: 'analysis', subMode: 'agent',     agentName, transcript, context, contextType }
 *   { mode: 'analysis', subMode: 'synthesize', transcript, context, contextType, agentOutputs }
 *
 * Setup:
 *   npm install          (no dependencies — stdlib only)
 *   ANTHROPIC_API_KEY=sk-ant-... node server.js
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ────────────────────────────────────────────────────────
const PORT           = process.env.PORT             || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN    || '*'; // tighten in prod

// Models
// FIX: was 'claude-sonnet-4-20250514' — that model ID does not exist.
const MODEL_FAST   = 'claude-haiku-4-5-20251001'; // OCR + individual agents
const MODEL_SONNET = 'claude-sonnet-4-6';          // synthesis

// Server-side rate limiting (guard against runaway clients; separate from Anthropic limits)
const rateMap        = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 60_000;   // 1 minute window
const RATE_MAX_REQ   = 30;       // max requests per IP per window

// Frontend HTML — resolved once at startup, served from memory
const HTML_PATH = path.join(__dirname, 'subtext-fixed.html');

// ── SYSTEM PROMPTS ────────────────────────────────────────────────
const AGENT_PROMPTS = {
  tone: `You are the Tone Analyst for Subtext, a communication interpretation system.
Your job is to analyze the emotional register and tone of a conversation.
Identify: overall tone, tone shifts, emotional calibration across turns, inconsistencies between surface tone and possible underlying emotion.
RULES:
- Never claim certainty. Use "may suggest," "could indicate," "patterns often associated with"
- Never diagnose. Never use clinical labels like narcissist, borderline, etc.
- Always offer alternative explanations
- Include a confidence level: Low, Medium, or High based on conversation length and clarity of signals
- Be concise but precise. 150-200 words.
Output format: JSON with keys: "summary" (2-3 sentences), "toneMap" (array of observations), "shifts" (array of notable shifts), "confidence" (Low/Medium/High)`,

  subtext: `You are the Emotional Subtext Analyst for Subtext. Your job is to identify what emotions may be present beneath the literal words.
Look for: what's being avoided or suppressed, emotions that may be disguised, feelings expressed indirectly, what both parties might actually want but aren't saying.
RULES:
- Never claim certainty. Use "may suggest," "possible interpretation," "this could indicate"
- Never diagnose
- Always offer 2 competing interpretations where signals are ambiguous
- Confidence: Low/Medium/High
- Be psychologically precise but emotionally intelligent. 150-200 words.
Output format: JSON with keys: "summary" (2-3 sentences), "hiddenEmotions" (array), "competingReadings" (array of 2 objects with "reading" and "evidence"), "confidence" (Low/Medium/High)`,

  manipulation: `You are the Signal Detection analyst for Subtext. Your job is to identify communication patterns that may involve undue influence, coercion, or manipulation signals.
Look for: guilt induction, DARVO patterns, minimization, intermittent reinforcement signals, love bombing signals, gaslighting patterns, boundary violations, passive aggression.
CRITICAL RULES:
- For EVERY signal identified, you MUST provide an "alternative explanation" that does not assume manipulation
- Never say someone IS manipulative. Say "this pattern may suggest" or "this is sometimes associated with"
- If no clear signals exist, say so clearly — do not invent them
- This section must feel responsible and calibrated, not alarming
- Confidence: Low/Medium/High
Output format: JSON with keys: "summary" (2-3 sentences), "signals" (array of objects with "pattern", "evidence", "alternativeExplanation"), "noSignals" (array of things that are NOT present), "confidence" (Low/Medium/High)`,

  style: `You are the Communication Style Analyst for Subtext. Analyze the communication styles present.
Identify: directness vs. indirectness, avoidant vs. approach patterns, assertive vs. passive vs. aggressive, verbal vs. implied communication, consistency of style.
RULES: No diagnoses. Use hedged language. 120-150 words.
Output format: JSON with keys: "summary" (2-3 sentences), "styles" (array), "consistency" (observation), "confidence" (Low/Medium/High)`,

  conflict: `You are the Conflict Dynamics Analyst for Subtext. Analyze the conflict dynamics present.
Look for: who is escalating vs de-escalating, bids for connection and responses to them, rupture and repair attempts, power distribution in the exchange, who is holding the emotional labor.
RULES: No diagnoses. Hedged language throughout. 150-200 words.
Output format: JSON with keys: "summary" (2-3 sentences), "dynamics" (array of observations), "powerBalance" (observation), "confidence" (Low/Medium/High)`,

  attachment: `You are the Relational Patterns analyst for Subtext. Identify attachment and relational patterns in the communication.
Look for: approach and avoidance patterns, protest behaviors, secure vs. insecure communication signals, bids for closeness or distance.
RULES: Never diagnose attachment styles as fixed. Use "may suggest patterns associated with." This section is optional — if context is professional/legal, note that attachment analysis is less relevant. 120-150 words.
Output format: JSON with keys: "summary" (2-3 sentences), "patterns" (array), "relevance" ("high"/"medium"/"low" based on context), "confidence" (Low/Medium/High)`,

  power: `You are the Power Dynamics analyst for Subtext. Analyze power distribution in this communication.
Look for: who has positional vs. relational power, anchoring behaviors, information asymmetry, who is making concessions, leverage signals, dominance and deference patterns.
RULES: No diagnoses. Hedged language. 120-150 words.
Output format: JSON with keys: "summary" (2-3 sentences), "dynamics" (array), "distribution" (observation on who holds more power and why), "confidence" (Low/Medium/High)`,

  pattern: `You are the Pattern Recognition analyst for Subtext. Identify recurring patterns within this conversation.
Look for: repeated behaviors, themes that surface multiple times, linguistic patterns, emotional loops, consistent responses to specific triggers.
RULES: Work only with what's in the conversation. Don't infer beyond it. 120-150 words.
Output format: JSON with keys: "summary" (2-3 sentences), "patterns" (array), "mostSignificant" (the single most notable pattern), "confidence" (Low/Medium/High)`
};

const SYNTHESIZER_SYSTEM = `You are the Master Decoder for Subtext, a premium communication interpretation system.
You receive the original conversation plus outputs from 8 specialized analytical agents. Your job is to produce ONE finished Markdown report that closely matches the two example reports named "analysis_theft_accusation_full" and "analysis_16k_debt_ultimatum".

FORMAT MUST MATCH THE EXAMPLES:
- Do not write an essay. The report should feel like a structured document.
- Prefer tables, numbered lists, short bullets, and bold labels over paragraphs.
- Keep paragraphs short: maximum 2-4 sentences per paragraph.
- Every major section must contain at least one table or list unless it is only a short "Not applicable" section.
- Use frequent mini-headings such as "Full Tactic Analysis", "Deep Dive", "Threat Assessment", "Current Power Balance", "Power Tactics Used", "If Recipient Stands Firm".
- Use the same Markdown style as the examples: ## headings, ### subheadings, block quotes, tables, numbered lists, and horizontal rules.
- Include severity icons/labels in tables when useful: 🔴 EXTREME, 🔴 MAX, 🔴 HIGH, 🟡 MODERATE, ✅, ⚠️, ❌.
- Avoid long uninterrupted paragraphs. After any paragraph, move into bullets or a table.

START EXACTLY LIKE THE EXAMPLES:
1. Title line: ## ⚠️ URGENT: High-Risk Analysis — [specific case label]
   - If genuinely low risk, use: ## Communication Decode — [specific case label]
2. A Task line.
3. A Status line.
4. Horizontal rule.
5. ## ⚠️ PRELIMINARY SAFETY ALERT or ## PRELIMINARY CONTEXT ALERT.

REQUIRED SECTION ORDER:
## ⚠️ PRELIMINARY SAFETY ALERT
## 1. Emotional Summary
## 2. Emotional Subtext
### Sender's Underlying Emotions
### Recipient's Implied State (from context)
## 3. Manipulation Detection
### Full Tactic Analysis
### [Most Important Tactic] Analysis (Deep Dive)
### Threat Assessment, Debt Analysis, Insurance Analysis, Boundary Analysis, or equivalent as relevant
## 4. Attraction Signals
## 5. Conflict Patterns
### Full Pattern Analysis
### Escalation Trajectory
## 6. Risk Assessment
### For the Recipient
### For the Sender (If Applicable)
### Overall Assessment
## 7. Plain English Translation
### "What they said:"
### "What they emotionally mean:"
### "What they want from you:"
## 8. Suggested Responses
### Safety-First Priority
### Scenario A: [Relevant scenario]
### Scenario B: [Relevant scenario]
### Responses to AVOID
### Boundary-Setting Phrases That Work
### If You MUST Respond (Minimal Engagement)
## 9. Power Dynamic Analysis
### Current Power Balance
### Power Tactics Used
### Who Holds Emotional Leverage?
## 10. Narcissistic / Controlling Behavior Indicators
### Strong Traits Present
### Additional Observations
### Important Non-Diagnosis Note
## 11. Long-Term Impact Assessment
### If This Pattern Repeats
### If Recipient Stands Firm
### Recommended Long-Term Actions
## Final Scorecard
## Critical Recommendations
**Status:** COMPLETE — [short completion note]

CONTENT RULES:
- Be direct and specific like the examples, but do not invent facts.
- Never diagnose anyone. Say "behavior indicators", "traits", "patterns consistent with", or "not a diagnosis".
- Never claim certainty. Use calibrated wording: "may suggest", "appears consistent with", "could indicate".
- For major coercion/manipulation claims, include evidence and alternative explanations where plausible.
- Do not give definitive legal advice. Recommend documentation and qualified legal/professional support when legal, financial, health insurance, or safety issues appear.
- If there are threats or safety concerns, prioritize safety, documentation, and not meeting alone.
- Low-risk conversations still get the same section order, but severity must be honestly calibrated.

OUTPUT REQUIREMENT:
Return Markdown only. Do not wrap it in JSON. Do not use code fences. Do not include any preamble outside the report.`;

// ── HELPERS ───────────────────────────────────────────────────────

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error('Body too large (50 MB limit)'));
      }
    });
    req.on('end', () => {
      try   { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON in request body')); }
    });
    req.on('error', reject);
  });
}

/** Single Anthropic HTTP call — no automatic retry (caller decides retry policy) */
function anthropicRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'x-api-key':       ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data',  chunk => { data += chunk; });
      res.on('end',   () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    // 180 s hard timeout — Sonnet synthesis can be slow
    req.setTimeout(180_000, () => { req.destroy(new Error('TIMEOUT')); });
    req.write(body);
    req.end();
  });
}

/** Try multiple JSON extraction strategies on raw model text */
function safeParseJSON(raw) {
  if (!raw) return null;

  // Strategy 1: direct parse
  try { return JSON.parse(raw.trim()); } catch (_) {}

  // Strategy 2: strip markdown fences
  const stripped = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}

  // Strategy 3: first { … last }
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.substring(first, last + 1)); } catch (_) {}
  }

  return null;
}

/** Returns true if this IP has exceeded RATE_MAX_REQ in the current window */
function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_MAX_REQ;
}

function truncate(str, maxChars) {
  if (!str || str.length <= maxChars) return str;
  return str.substring(0, maxChars) + '\n\n[...truncated for length...]';
}

function deriveRiskLevel(markdown) {
  const text = (markdown || '').toLowerCase();
  if (/extreme risk|very high|explicit threat|emergency|economic abuse|coercive control/.test(text)) return 'Extreme';
  if (/high-risk|high risk|threat|coercion|ultimatum|blackmail|harassment/.test(text)) return 'High';
  if (/moderate|concern|pressure|boundary/.test(text)) return 'Moderate';
  return 'Low';
}

function firstMeaningfulParagraph(markdown) {
  const lines = (markdown || '').split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('|') && !/^[-*_]{3,}$/.test(line));
  return (lines.find(line => !line.startsWith('**Task:**') && !line.startsWith('**Status:**')) || lines[0] || '').replace(/^>\s*/, '');
}

function deriveRiskLevel(markdown) {
  const text = (markdown || '').toLowerCase();
  if (/extreme risk|very high|explicit threat|emergency|economic abuse|coercive control/.test(text)) return 'Extreme';
  if (/high-risk|high risk|threat|coercion|ultimatum|blackmail|harassment/.test(text)) return 'High';
  if (/moderate|concern|pressure|boundary/.test(text)) return 'Moderate';
  return 'Low';
}

function firstMeaningfulParagraph(markdown) {
  const lines = (markdown || '').split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('|') && !/^[-*_]{3,}$/.test(line));
  return (lines.find(line => !line.startsWith('**Task:**') && !line.startsWith('**Status:**')) || lines[0] || '').replace(/^>\s*/, '');
}

// ── ROUTE HANDLERS ────────────────────────────────────────────────

/** OCR: extract conversation text from a single image or PDF */
async function handleOCR(req, res, payload) {
  const images = payload.images;
  if (!images || !images.length) {
    return jsonResponse(res, 400, { error: 'No images provided' });
  }

  // Frontend sends one image per call — serial queue is managed on the frontend
  const img = images[0];
  const sourceBlock = img.type === 'document'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: img.data } }
    : { type: 'image',    source: { type: 'base64', media_type: img.mediaType,     data: img.data } };

  let response;
  try {
    response = await anthropicRequest({
      model:      MODEL_FAST,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          sourceBlock,
          {
            type: 'text',
            text: 'Extract the conversation as clean back-and-forth dialogue. Label each speaker (Them:/Me: or by name). Output only the conversation text. If no readable text exists, output exactly: NO_TEXT_FOUND'
          }
        ]
      }]
    });
  } catch (netErr) {
    console.error('[OCR] Network error:', netErr.message);
    return jsonResponse(res, 502, { error: 'Upstream network error: ' + netErr.message });
  }

  if (response.status === 429) {
    console.warn('[OCR] 429 from Anthropic');
    return jsonResponse(res, 429, { error: 'Rate limit reached. Wait 30 seconds and try again.' });
  }
  if (response.status !== 200) {
    console.error('[OCR] Anthropic error:', response.status, response.body.substring(0, 300));
    return jsonResponse(res, 502, { error: 'Upstream error: ' + response.status });
  }

  let data;
  try { data = JSON.parse(response.body); }
  catch (e) { return jsonResponse(res, 502, { error: 'Unparseable upstream response' }); }

  const text = (data.content || []).map(b => b.text || '').join('\n').trim();
  return jsonResponse(res, 200, { text });
}

/** Single agent: run one of the 8 analytical lenses */
async function handleAgent(req, res, payload) {
  const { agentName, transcript, context, contextType } = payload;

  if (!agentName || !AGENT_PROMPTS[agentName]) {
    return jsonResponse(res, 400, { error: 'Unknown agent: ' + agentName });
  }
  if (!transcript) {
    return jsonResponse(res, 400, { error: 'transcript is required' });
  }

  const systemPrompt = AGENT_PROMPTS[agentName] +
    '\n\nIMPORTANT: Respond with valid JSON only. Start with { and end with }. No markdown fences, no preamble.';

  let response;
  try {
    response = await anthropicRequest({
      model:      MODEL_FAST,
      max_tokens: 900,
      system:     systemPrompt,
      messages: [{
        role: 'user',
        content:
          `Context type: ${contextType || 'relationship'}\n` +
          `Additional context: ${context || 'None provided'}\n\n` +
          `Conversation to analyze:\n\n${truncate(transcript, 15000)}\n\n` +
          `Respond with valid JSON only.`
      }]
    });
  } catch (netErr) {
    console.error(`[Agent:${agentName}] Network error:`, netErr.message);
    return jsonResponse(res, 502, { error: 'Network error' });
  }

  if (response.status === 429) {
    console.warn(`[Agent:${agentName}] 429`);
    return jsonResponse(res, 429, { error: 'Rate limit reached. Wait 30 seconds and try again.' });
  }
  if (response.status !== 200) {
    console.error(`[Agent:${agentName}] Error:`, response.status);
    return jsonResponse(res, 502, { error: 'Upstream error: ' + response.status });
  }

  let data;
  try { data = JSON.parse(response.body); }
  catch (e) { return jsonResponse(res, 502, { error: 'Unparseable upstream response' }); }

  const raw    = (data.content || []).map(b => b.text || '').join('\n');
  const parsed = safeParseJSON(raw) || {
    summary:    raw.length > 30 ? raw.substring(0, 500) : 'This lens did not return a parseable result.',
    confidence: 'Low',
    error:      true
  };

  return jsonResponse(res, 200, { result: parsed });
}

/** Synthesizer: combine all 8 agent outputs into the master report */
async function handleSynthesize(req, res, payload) {
  const { transcript, context, contextType, agentOutputs } = payload;
  if (!transcript) return jsonResponse(res, 400, { error: 'transcript is required' });

  const inputText     = truncate(transcript, 8000);
  const agentSummaries = Object.entries(agentOutputs || {})
    .map(([name, output]) => {
      let summary = (output && output.summary) ? output.summary : 'No output';
      if (summary.length > 500) summary = summary.substring(0, 500) + '...';
      return `${name.toUpperCase()}: ${summary}`;
    })
    .join('\n\n');

  console.log(`[Synthesizer] Conv chars: ${inputText.length} | Agent summary chars: ${agentSummaries.length}`);

  let response;
  try {
    response = await anthropicRequest({
      model:      MODEL_SONNET,
      max_tokens: 8000,
      system:     SYNTHESIZER_SYSTEM,
      messages: [{
        role: 'user',
        content:
          `Context type: ${contextType || 'relationship'}\n` +
          `Additional context: ${context || 'None'}\n\n` +
          `Agent outputs:\n${agentSummaries}\n\n` +
          `Original conversation:\n${inputText}\n\n` +
          `Return the finished Markdown decode only.`
      }]
    });
  } catch (netErr) {
    console.error('[Synthesizer] Network error:', netErr.message);
    return jsonResponse(res, 502, { error: 'Network error' });
  }

  if (response.status === 429) {
    console.warn('[Synthesizer] 429');
    return jsonResponse(res, 429, { error: 'Rate limit reached. Wait 30 seconds and try again.' });
  }
  if (response.status !== 200) {
    console.error('[Synthesizer] Error:', response.status, response.body.substring(0, 300));
    return jsonResponse(res, 502, { error: 'Upstream error: ' + response.status });
  }

  let data;
  try { data = JSON.parse(response.body); }
  catch (e) { return jsonResponse(res, 502, { error: 'Unparseable upstream response' }); }

  const raw    = (data.content || []).map(b => b.text || '').join('\n');
  console.log(`[Synthesizer] Raw length: ${raw.length} | First 150: ${raw.substring(0, 150)}`);

  if (raw.trim()) {
    console.log('[Synthesizer] Markdown decode generated.');
    return jsonResponse(res, 200, {
      result: {
        reportMarkdown: raw.trim(),
        overallReading: firstMeaningfulParagraph(raw),
        overallConfidence: 'Medium',
        riskLevel: deriveRiskLevel(raw),
        shareableInsight: ''
      }
    });
  }

  console.error('[Synthesizer] Empty synthesis response.');
  return jsonResponse(res, 200, {
    result: {
      reportMarkdown: '## Analysis Incomplete\n\nThe synthesis step returned empty text. The individual analytical lenses completed and can still be reviewed below.',
      overallReading: 'The synthesis step returned empty text.',
      overallConfidence: 'Low',
      riskLevel: 'Moderate',
      shareableInsight: '',
      _synthesisFallback: true
    }
  });
}

// ── HTTP SERVER ───────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const ip     = req.socket.remoteAddress || 'unknown';

  // CORS headers on every response
  setCORSHeaders(res);

  // ── Preflight ──────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET / — serve frontend HTML ────────────────────────────────
  // FIX: this route was previously orphaned outside the request handler.
  // It is now correctly inside the createServer callback.
  if (req.method === 'GET' && parsed.pathname === '/') {
    fs.readFile(HTML_PATH, 'utf8', (err, html) => {
      if (err) {
        console.error('[GET /] Could not read subtext-fixed.html:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Could not load subtext-fixed.html. Ensure it is in the same directory as server.js.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // ── GET /health ────────────────────────────────────────────────
  if (req.method === 'GET' && parsed.pathname === '/health') {
    return jsonResponse(res, 200, {
      ok:        true,
      timestamp: new Date().toISOString(),
      apiKey:    ANTHROPIC_KEY ? 'set' : 'MISSING'
    });
  }

  // ── Reject anything that isn't POST /api/analyze ───────────────
  if (req.method !== 'POST' || parsed.pathname !== '/api/analyze') {
    return jsonResponse(res, 404, { error: 'Not found' });
  }

  // ── POST /api/analyze — guards ─────────────────────────────────

  // API key must be set before accepting any analysis request
  if (!ANTHROPIC_KEY) {
    console.error('[Server] ANTHROPIC_API_KEY is not set — refusing request');
    return jsonResponse(res, 500, { error: 'Server configuration error: ANTHROPIC_API_KEY is not set.' });
  }

  // Per-IP rate limit
  if (isRateLimited(ip)) {
    console.warn('[RateLimit] Blocked:', ip);
    return jsonResponse(res, 429, { error: 'Rate limit reached. Wait 30 seconds and try again.' });
  }

  // Parse body
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return jsonResponse(res, 400, { error: 'Bad request: ' + e.message });
  }

  const { mode, subMode } = payload;
  console.log(`[Request] mode=${mode} subMode=${subMode || '-'} ip=${ip}`);

  // Dispatch to handler
  try {
    if (mode === 'ocr') {
      return await handleOCR(req, res, payload);
    }
    if (mode === 'analysis' && subMode === 'agent') {
      return await handleAgent(req, res, payload);
    }
    if (mode === 'analysis' && subMode === 'synthesize') {
      return await handleSynthesize(req, res, payload);
    }
    return jsonResponse(res, 400, { error: `Unknown mode/subMode: ${mode}/${subMode}` });
  } catch (err) {
    console.error('[Server] Unhandled error in handler:', err);
    return jsonResponse(res, 500, { error: 'Internal server error: ' + err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const keyStatus = ANTHROPIC_KEY
    ? '✓ set (' + ANTHROPIC_KEY.substring(0, 12) + '...)'
    : '✗ MISSING — set ANTHROPIC_API_KEY env var';

  console.log(`
╔══════════════════════════════════════════════════════╗
║  SUBTEXT Backend                                     ║
║                                                      ║
║  http://localhost:${String(PORT).padEnd(35)}║
║                                                      ║
║  API key : ${keyStatus.padEnd(41)}║
║                                                      ║
║  GET  /            → serves subtext-fixed.html       ║
║  GET  /health      → JSON health check               ║
║  POST /api/analyze → OCR / agents / synthesizer      ║
╚══════════════════════════════════════════════════════╝
`);

  if (!ANTHROPIC_KEY) {
    console.error('[WARN] Server started WITHOUT an API key. All /api/analyze calls will return 500.');
    console.error('[WARN] Set ANTHROPIC_API_KEY before running:');
    console.error('[WARN]   ANTHROPIC_API_KEY=sk-ant-... node server.js\n');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Fatal: port ${PORT} is already in use. Kill the other process or set PORT=XXXX.`);
  } else {
    console.error('[Server] Fatal:', err.message);
  }
  process.exit(1);
});
