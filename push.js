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
// Without APNS_KEY the module still tracks watches but only logs what it would send.
const fs = require("fs");
const http2 = require("http2");
const path = require("path");
const jwt = require("jsonwebtoken");

const HOSTS = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
const TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const FN_RE = /^[A-Z0-9]{2}\d{1,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A .p8 pasted into a web form often loses its line breaks (they become spaces) or
// arrives as literal "\n". Rebuild a valid PEM from the base64 body either way.
function normalizeKey(raw) {
  const k = String(raw || "").replace(/\\n/g, "\n").trim();
  const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return k;
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
  const send = opts.send ?? apnsSend;
  const enabled = !!(cfg.key && cfg.keyId && cfg.teamId);

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
      if (!r.ok && r.reason === "BadDeviceToken") r = await apnsOnce(token, payload, "sandbox");
      return r;
    } catch (e) {
      // e.g. the key can't be parsed — report it instead of crashing the request
      return { ok: false, status: 0, reason: `key/signing error: ${String(e.message || e).slice(0, 120)}` };
    }
  }

  // ── Registration ────────────────────────────────────────────────────────
  // Replace-set semantics per device: whatever the app sends is the full list.
  function register(token, flights) {
    if (!TOKEN_RE.test(String(token || ""))) return { error: "bad token" };
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
      if (r.status === 410 || r.reason === "Unregistered") {
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
    if (!TOKEN_RE.test(String(token || ""))) return { ok: false, reason: "bad token" };
    if (now() - (lastTest.get(token) || 0) < 30000) return { ok: false, reason: "wait 30s between tests" };
    lastTest.set(token, now());
    if (!enabled) return { ok: false, reason: "APNs not configured on the server" };
    return send(token, "✈️ Flownto test alert", "Closed-app alerts are working.", { page: "dashboard" });
  }

  return { register, pollOnce, start, diff, enabled, sendTest, _watches: () => watches, _send: send };
}

module.exports = { createPush, normalizeKey };
