// Server-side flight alerts (delay / gate / cancelled / boarding) via APNs.
//
// The app registers its device token + the flights it cares about (POST /watch).
// A poller re-checks those flights and pushes an alert when something changes, so
// alerts arrive even when the app is fully closed.
//
// Needs (set on Render, never committed):
//   APNS_KEY      contents of the AuthKey_XXXX.p8 file (PEM; "\n" escapes are fine)
//   APNS_KEY_ID   the 10-char Key ID
//   APNS_TEAM_ID  Apple Team ID (falls back to MAPKIT_TEAM_ID — same team)
//   APNS_BUNDLE_ID (optional, default com.flownto.app)
//   FCM_SERVICE_ACCOUNT  (Android) the Firebase service-account JSON (raw, or base64 of it)
// Without keys the module still tracks watches but only logs what it would send.
const fs = require("fs");
const http2 = require("http2");
const path = require("path");
const jwt = require("jsonwebtoken");

const HOSTS = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
const TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const FN_RE = /^[A-Z0-9]{2}\d{1,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Android (Firebase) registration tokens look like "<id>:APA91b…" — never plain hex.
const FCM_RE = /^[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{40,}$/;
function tokenKind(t) {
  const s = String(t || "");
  if (TOKEN_RE.test(s)) return "apns";
  if (FCM_RE.test(s)) return "fcm";
  return null;
}

// The Firebase key arrives via an env var and often gets mangled when pasted (real newlines
// inside the private key, or the whole file base64'd). Accept JSON, base64 JSON, or a
// paste with raw newlines; pull out the three fields we need.
function parseServiceAccount(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (!t.startsWith("{") && !t.includes('"private_key"')) {
    try { t = Buffer.from(t, "base64").toString("utf8"); } catch { return null; }
  }
  let o = null;
  try { o = JSON.parse(t); } catch {
    const g = (k) => (t.match(new RegExp(`"${k}"\\s*:\\s*"([\\s\\S]*?)"\\s*[,}]`)) || [])[1];
    o = { project_id: g("project_id"), client_email: g("client_email"), private_key: g("private_key") };
  }
  if (!o || !o.project_id || !o.client_email || !o.private_key) return null;
  o.private_key = String(o.private_key).replace(/\\n/g, "\n");
  return o;
}

// A .p8 pasted into a web form often loses its line breaks (they become spaces) or
// arrives as literal "\n". Rebuild a valid PEM from the base64 body either way.
function normalizeKey(raw) {
  const k = String(raw || "").replace(/\\n/g, "\n").trim();
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) {
    // No BEGIN/END lines (only the base64 body was pasted) — wrap it as a PKCS#8 key.
    const bare = k.replace(/[\s"']+/g, "");
    if (/^[A-Za-z0-9+/=]{100,}$/.test(bare))
      return `-----BEGIN PRIVATE KEY-----\n${(bare.match(/.{1,64}/g) || []).join("\n")}\n-----END PRIVATE KEY-----\n`;
    return k;
  }
  const body = m[2].replace(/\s+/g, "");
  return `-----BEGIN ${m[1]}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${m[1]}-----\n`;
}

function createPush(opts = {}) {
  const cfg = {
    key: normalizeKey(opts.key ?? process.env.APNS_KEY ?? ""),
    keyId: opts.keyId ?? process.env.APNS_KEY_ID ?? "",
    teamId: opts.teamId ?? process.env.APNS_TEAM_ID ?? process.env.MAPKIT_TEAM_ID ?? "",
    bundleId: opts.bundleId ?? process.env.APNS_BUNDLE_ID ?? "com.flownto.app",
  };
  const file = opts.file ?? path.join(process.env.DATA_DIR || __dirname, "watches.json");
  const now = opts.now ?? (() => Date.now());
  const fetchFlight = opts.fetchFlight; // async (fn, date, maxAgeSec) => flight-info payload
  // One entry point: pick the sender from the token's format.
  const send = opts.send ?? ((token, title, body, data) =>
    tokenKind(token) === "fcm" ? fcmSend(token, title, body, data) : apnsSend(token, title, body, data));
  const enabled = !!(cfg.key && cfg.keyId && cfg.teamId);
  const sa = parseServiceAccount(opts.fcm ?? process.env.FCM_SERVICE_ACCOUNT ?? "");
  const fcmEnabled = !!sa;
  const http = opts.http ?? require("axios");

  // key `${token}|${fn}|${date}` → { token, fn, date, snap, sentBoarding, lastSeen }
  let watches = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    watches = new Map(Object.entries(raw));
  } catch {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(Object.fromEntries(watches))); } catch {} };

  // ── APNs ────────────────────────────────────────────────────────────────
  let jwtCache = { at: 0, value: "" };
  function providerToken() {
    if (now() - jwtCache.at > 50 * 60 * 1000) {
      jwtCache = {
        at: now(),
        value: jwt.sign({}, cfg.key, { algorithm: "ES256", keyid: cfg.keyId, issuer: cfg.teamId, header: { alg: "ES256", kid: cfg.keyId } }),
      };
    }
    return jwtCache.value;
  }
  function apnsOnce(token, payload, env) {
    return new Promise((resolve) => {
      const client = http2.connect(`https://${HOSTS[env]}`);
      let done = false;
      const finish = (r) => { if (!done) { done = true; try { client.close(); } catch {} resolve(r); } };
      client.on("error", (e) => finish({ ok: false, status: 0, reason: String(e.message || e) }));
      const req = client.request({
        ":method": "POST", ":path": `/3/device/${token}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": cfg.bundleId, "apns-push-type": "alert", "apns-priority": "10",
        "content-type": "application/json",
      });
      let status = 0, body = "";
      req.on("response", (h) => { status = h[":status"]; });
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let reason = ""; try { reason = JSON.parse(body).reason || ""; } catch {}
        finish({ ok: status === 200, status, reason });
      });
      req.on("error", (e) => finish({ ok: false, status: 0, reason: String(e.message || e) }));
      req.setTimeout(10000, () => finish({ ok: false, status: 0, reason: "timeout" }));
      req.end(JSON.stringify(payload));
    });
  }
  // TestFlight / App Store tokens are production; Xcode-run builds are sandbox.
  // We don't know which, so try production first and fall back on BadDeviceToken.
  async function apnsSend(token, title, body, data = {}) {
    if (!enabled) { console.log(`[push] (APNs not configured) would send: ${title} — ${body}`); return { ok: true, skipped: true }; }
    const payload = { aps: { alert: { title, body }, sound: "default" }, ...data };
    try {
      let r = await apnsOnce(token, payload, "production");
      r.env = "production";
      if (!r.ok && r.reason === "BadDeviceToken") { r = await apnsOnce(token, payload, "sandbox"); r.env = "sandbox"; }
      return r;
    } catch (e) {
      // e.g. the key can't be parsed — report it instead of crashing the request
      return { ok: false, status: 0, reason: `key/signing error: ${String(e.message || e).slice(0, 120)}` };
    }
  }

  // ── Firebase Cloud Messaging (Android) ──────────────────────────────────
  let fcmTok = { value: "", exp: 0 };
  async function fcmAccessToken() {
    if (fcmTok.value && now() < fcmTok.exp) return fcmTok.value;
    const iat = Math.floor(now() / 1000);
    const assertion = jwt.sign(
      { iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 },
      sa.private_key, { algorithm: "RS256" });
    const r = await http.post("https://oauth2.googleapis.com/token",
      new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    fcmTok = { value: r.data.access_token, exp: now() + Math.max(60, (r.data.expires_in || 3600) - 300) * 1000 };
    return fcmTok.value;
  }
  async function fcmSend(token, title, body, data = {}) {
    if (!fcmEnabled) { console.log(`[push] (FCM not configured) would send: ${title} — ${body}`); return { ok: true, skipped: true }; }
    try {
      const at = await fcmAccessToken();
      const message = {
        token, notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        // High priority + our own channel (created by the app) so it pops up like an alert.
        android: { priority: "HIGH", notification: { channel_id: "flight_alerts", sound: "default" } },
      };
      const r = await http.post(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { message },
        { headers: { Authorization: `Bearer ${at}` }, timeout: 10000, validateStatus: () => true });
      if (r.status === 200) return { ok: true, status: 200, env: "fcm" };
      const code = r.data?.error?.details?.[0]?.errorCode || r.data?.error?.status || "";
      return { ok: false, status: r.status, env: "fcm", reason: code || String(r.data?.error?.message || "error").slice(0, 100),
               unregistered: r.status === 404 || code === "UNREGISTERED" };
    } catch (e) {
      return { ok: false, status: 0, env: "fcm", reason: `fcm error: ${String(e.response?.data?.error_description || e.message || e).slice(0, 100)}` };
    }
  }

  // ── Registration ────────────────────────────────────────────────────────
  // Replace-set semantics per device: whatever the app sends is the full list.
  function register(token, flights) {
    if (!tokenKind(token)) return { error: "bad token" };
    const list = (Array.isArray(flights) ? flights : []).slice(0, 20).map((f) => ({
      fn: String(f?.flightNumber || "").replace(/\s/g, "").toUpperCase(), date: String(f?.date || ""),
    })).filter((f) => FN_RE.test(f.fn) && DATE_RE.test(f.date));
    const keep = new Set(list.map((f) => `${token}|${f.fn}|${f.date}`));
    for (const k of [...watches.keys()]) if (k.startsWith(token + "|") && !keep.has(k)) watches.delete(k);
    for (const f of list) {
      const k = `${token}|${f.fn}|${f.date}`;
      const prev = watches.get(k);
      watches.set(k, { token, fn: f.fn, date: f.date, snap: prev?.snap || null, sentBoarding: !!prev?.sentBoarding, lastSeen: now() });
    }
    save();
    return { ok: true, watching: list.length };
  }

  // ── Diff → alerts ───────────────────────────────────────────────────────
  const hhmm = (s) => { const m = String(s || "").match(/(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
  const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + "m" : ""}`.trim() : `${m}m`);

  // Pure: given previous snapshot + fresh data → { alerts:[{title,body}], snap }
  function diff(prev, d, wa) {
    const label = `${d.flightNumber || wa.fn}${d.from && d.to ? ` ${d.from}→${d.to}` : ""}`;
    const delay = Number(d.delayMinutes) || 0;
    const gate = d.fromGate || "", terminal = d.fromTerminal || "";
    const status = String(d.status || "").toLowerCase();
    const snap = { delay, gate, terminal, status };
    const alerts = [];
    if (!prev) return { alerts, snap }; // first observation: baseline only, never announce what already existed
    if (status.includes("cancel") && !prev.status.includes("cancel")) {
      alerts.push({ title: "❌ Flight cancelled", body: `${label} has been cancelled.` });
    } else {
      if (delay >= 10 && Math.abs(delay - prev.delay) >= 10) {
        const dep = hhmm(d.revisedDep);
        alerts.push({
          title: prev.delay >= 10 ? "⚠️ Delay updated" : "⚠️ Flight delayed",
          body: `${label} is now ${fmtMins(delay)} late${dep ? ` — departs ${dep}` : ""}.`,
        });
      } else if (delay < 10 && prev.delay >= 10) {
        alerts.push({ title: "✅ Back on time", body: `${label} is back on schedule.` });
      }
      if (gate && gate !== prev.gate) {
        const t = terminal ? ` (Terminal ${terminal})` : "";
        alerts.push({
          title: prev.gate ? "🚪 Gate changed" : "🚪 Gate posted",
          body: prev.gate ? `${label}: gate ${prev.gate} → ${gate}${t}.` : `${label}: go to gate ${gate}${t}.`,
        });
      }
    }
    return { alerts, snap };
  }

  async function checkOne(w) {
    const dep = Date.parse(`${w.date}T00:00:00Z`);
    const hoursOut = (dep - now()) / 3600000;
    if (hoursOut > 36 + 14) return false;          // too early to bother
    if (hoursOut < -48) { watches.delete(`${w.token}|${w.fn}|${w.date}`); return true; } // long gone
    const near = hoursOut < 8;
    const d = await fetchFlight(w.fn, w.date, near ? 300 : 1800);
    if (!d || !d.found) return false;
    const { alerts, snap } = diff(w.snap, d, w);
    // Boarding — once, from the source's own status.
    const isBoarding = String(d.status || "").toLowerCase().includes("boarding");
    if (isBoarding && !w.sentBoarding && w.snap) {
      alerts.push({ title: "🛫 Boarding now", body: `${d.flightNumber || w.fn}${d.fromGate ? ` — gate ${d.fromGate}` : ""}.` });
      w.sentBoarding = true;
    }
    w.snap = snap;
    for (const a of alerts) {
      const r = await send(w.token, a.title, a.body, { page: "dashboard" });
      console.log(`[push] ${w.fn} ${w.date}: "${a.title}" → ${r.ok ? "sent" : `failed (${r.status} ${r.reason})`}`);
      if (r.unregistered || r.status === 410 || r.reason === "Unregistered") {
        for (const k of [...watches.keys()]) if (k.startsWith(w.token + "|")) watches.delete(k);
        break;
      }
    }
    const landed = /arriv|land/.test(String(d.status || "").toLowerCase());
    if (landed) watches.delete(`${w.token}|${w.fn}|${w.date}`);
    return true;
  }

  async function pollOnce() {
    // fetchFlight goes through the server's own cache, so many devices watching one
    // flight cost one upstream lookup per cache window.
    for (const w of [...watches.values()]) {
      try { await checkOne(w); } catch (e) { console.warn("[push] check failed:", w.fn, e.message); }
    }
    save();
  }

  let timer = null;
  function start(everyMs = 5 * 60 * 1000) {
    if (timer) return;
    console.log(`[push] watcher started (APNs ${enabled ? "configured" : "NOT configured — dry run"}), ${watches.size} watch(es) loaded`);
    timer = setInterval(() => pollOnce().catch(() => {}), everyMs);
  }

  // One-off self-test: send an alert to a single device token (rate-limited). Returns
  // Apple's own response so setup problems (bad key, wrong topic…) are visible.
  const lastTest = new Map();
  async function sendTest(token) {
    const kind = tokenKind(token);
    if (!kind) return { ok: false, reason: "bad token" };
    if (now() - (lastTest.get(token) || 0) < 30000) return { ok: false, reason: "wait 30s between tests" };
    lastTest.set(token, now());
    if (kind === "apns" && !enabled) return { ok: false, reason: "APNs not configured on the server" };
    if (kind === "fcm" && !fcmEnabled) return { ok: false, reason: "Android (FCM) is not configured on the server" };
    return send(token, "✈️ Flownto test alert", "Closed-app alerts are working.", { page: "dashboard" });
  }

  // Shape only (never the key): lets setup be debugged without exposing the secret.
  function keyInfo() {
    const raw = String(process.env.APNS_KEY || "");
    const m = raw.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
    let parses = false;
    try { require("crypto").createPrivateKey(cfg.key); parses = true; } catch {}
    return {
      rawLength: raw.length, hasBegin: /-----BEGIN/.test(raw), hasEnd: /-----END/.test(raw),
      type: m ? m[1] : null, bodyChars: m ? m[2].replace(/\s+/g, "").length : null,
      parses, keyIdLength: cfg.keyId.length, teamIdLength: cfg.teamId.length,
      fcm: { configured: fcmEnabled, projectId: sa ? sa.project_id : null },
    };
  }

  return { register, pollOnce, start, diff, enabled, sendTest, keyInfo, _watches: () => watches, _send: send };
}

module.exports = { createPush, normalizeKey, tokenKind, parseServiceAccount };
