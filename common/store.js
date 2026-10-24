// Shared settings, audio files and live link between the phone and the laptop studio.
// Online (Supabase) when configured and signed in; otherwise everything stays on this device.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const DEFAULTS = {
  slow: 1.5, fast: 0.08, curve: 1,
  rate: 0.95, pitch: 0.7, voice: "",
  closesecs: 2, groupsecs: 5, closeat: 0.75,
  closelines: "I see you.\nYou are very close now.\nStanding still will not make you invisible.\nI have been watching this alley all day. You are the most interesting thing so far.\nPlease keep walking.",
  grouplines: "Two of you. Interesting.\nGathering here has been noted.\nI am counting all of you.\nYou can stay. I am not going anywhere either.",
  geiger: true, shapebeep: false, msens: 6, autozoom: true, volume: 1, minscore: 0.5, linegap: 2,
};
export const PHONE_DEFAULTS = { hFar: 0.05, hNear: 0.8, calibrated: false, voices: [], ignore: [] };
export const KINDS = ["close", "group", "beep", "geiger"];

export const cloudOn = !!(SUPABASE_URL && SUPABASE_KEY && window.supabase);
export const sb = cloudOn ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

// ---- sign in ----
export async function currentUser() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session ? data.session.user : null;
}
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}
export async function signOut() { if (sb) await sb.auth.signOut(); }

// ---- documents: "settings", "files", "phone" ----
const local = {
  get(id) { try { return JSON.parse(localStorage.getItem("ibs-doc-" + id) || "null"); } catch { return null; } },
  set(id, v) { try { localStorage.setItem("ibs-doc-" + id, JSON.stringify(v)); } catch {} },
};
const BASE = { settings: DEFAULTS, phone: PHONE_DEFAULTS, files: { close: [], group: [], beep: [], geiger: [] } };

export async function load(id) {
  let v = local.get(id);
  if (sb && await currentUser()) {
    const { data, error } = await sb.from("studio").select("data").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) { v = data.data; local.set(id, v); }
  }
  return { ...BASE[id], ...(v || {}) };
}

const timers = {}, savedAt = {};
export const net = { error: "", lastOk: 0 };
function ok() { net.error = ""; net.lastOk = Date.now(); }
function fail(e) { net.error = e.message || String(e); }
// Saves are grouped: rapid slider moves send one write after a short pause.
export function save(id, value, delay = 400) {
  local.set(id, value); savedAt[id] = Date.now();
  if (!sb) return Promise.resolve();
  clearTimeout(timers[id]);
  return new Promise((res, rej) => {
    timers[id] = setTimeout(async () => {
      savedAt[id] = Date.now();
      const { error } = await sb.from("studio").upsert({ id, data: value, updated_at: new Date().toISOString() });
      if (error) { fail(error); rej(new Error(error.message)); } else { ok(); res(); }
    }, delay);
  });
}

// Checks every 2 s for changes saved by the other device and calls back with (id, data).
// (Plain reads instead of a live socket: slower, but works on any network.)
export function onChange(cb, ids = ["settings", "files", "phone"]) {
  if (!sb) return () => {};
  const seen = {}; let first = true;
  const tick = async () => {
    const { data, error } = await sb.from("studio").select("id,data,updated_at").in("id", ids);
    if (error) { fail(error); return; }
    ok();
    if (first) { first = false; for (const id of ids) seen[id] = null; for (const r of data || []) seen[r.id] = r.updated_at; return; }
    for (const r of data || []) {
      if (r.updated_at === seen[r.id]) continue;
      seen[r.id] = r.updated_at;
      if (Date.now() - (savedAt[r.id] || 0) < 3000) continue; // our own recent save coming back
      local.set(r.id, r.data); cb(r.id, { ...BASE[r.id], ...r.data });
    }
  };
  tick(); const h = setInterval(tick, 1200);
  return () => clearInterval(h);
}

// ---- live link between phone and studio, through two small rows ----
// Each side writes its own row about once a second: the latest state (status, camera picture)
// plus a short list of recent messages (log lines, commands). The other side reads it.
export function live(role) {
  if (!sb) return null;
  const mine = "live-" + role, theirs = "live-" + (role === "phone" ? "studio" : "phone");
  const latest = {}, queue = [], handlers = {}, done = new Set(), latestT = {};
  let dirty = false, busy = false, counter = 0, lastSeq = null;
  const fire = (event, payload, t) => (handlers[event] || []).forEach(f => f(payload, t));
  const takeMsg = m => { if (done.has(m.seq)) return; done.add(m.seq); if (done.size > 500) done.delete(done.values().next().value); fire(m.event, m.payload); };
  const takeLatest = (ev, p, t) => { if (t <= (latestT[ev] || 0)) return; latestT[ev] = t; fire(ev, p, t); };

  // Fast path: a live socket, when the network allows it.
  let sockOk = false;
  let ch = null;
  try {
    ch = sb.channel("studio-live-v2", { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "m" }, ({ payload }) => {
      if (!payload || payload.from === role) return;
      if (payload.seq) { if (lastSeq === null || payload.seq > lastSeq) takeMsg(payload); }
      else takeLatest(payload.event, payload.payload, payload.t);
    }).subscribe(st => { sockOk = st === "SUBSCRIBED"; });
  } catch { ch = null; }
  const sendSock = payload => { if (sockOk && ch) try { ch.send({ type: "broadcast", event: "m", payload }); } catch {} };

  // Reliable path: two rows in the table, written and read every half second.
  const flush = async () => {
    if (!dirty || busy) return; dirty = false; busy = true;
    const t = Date.now();
    const { error } = await sb.from("studio").upsert({ id: mine, data: { t, latest, latestT: { ...latestOut }, queue: queue.slice(-30) }, updated_at: new Date().toISOString() });
    busy = false;
    if (error) { fail(error); dirty = true; } else ok();
  };
  const latestOut = {};
  const read = async () => {
    const { data, error } = await sb.from("studio").select("data").eq("id", theirs).maybeSingle();
    if (error) { fail(error); return; }
    ok();
    const d = data && data.data; if (!d) { if (lastSeq === null) lastSeq = 0; return; }
    const q = d.queue || [];
    if (lastSeq === null) { lastSeq = q.length ? q[q.length - 1].seq : 0; q.forEach(m => done.add(m.seq)); } // don't replay old commands
    for (const m of q) if (m.seq > lastSeq) takeMsg(m);
    lastSeq = Math.max(lastSeq, ...q.map(m => m.seq), 0);
    for (const [ev, p] of Object.entries(d.latest || {})) takeLatest(ev, p, (d.latestT && d.latestT[ev]) || d.t);
  };
  setInterval(flush, 500);
  setInterval(read, 500);
  return {
    // status/snap replace each other (only the newest matters); everything else is delivered once, in order.
    send(event, payload) {
      const t = Date.now();
      if (event === "status" || event === "snap") {
        latest[event] = payload; latestOut[event] = t;
        sendSock({ from: role, event, payload, t });
      } else {
        const m = { seq: t * 100 + (counter++ % 100), event, payload };
        queue.push(m); if (queue.length > 60) queue.splice(0, queue.length - 60);
        sendSock({ from: role, ...m });
      }
      dirty = true;
    },
    on(event, f) { (handlers[event] = handlers[event] || []).push(f); },
    get fast() { return sockOk; },
  };
}

// ---- audio files ----
const idb = new Promise((res, rej) => {
  const r = indexedDB.open("ibs-audio", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("blobs");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function cacheGet(k) { const db = await idb; return new Promise(res => { const q = db.transaction("blobs").objectStore("blobs").get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
async function cachePut(k, v) { const db = await idb; return new Promise(res => { const t = db.transaction("blobs", "readwrite"); t.objectStore("blobs").put(v, k); t.oncomplete = res; t.onerror = res; }); }

// Returns a list entry {name, path}. Online: uploaded to storage. Offline: kept on this device.
export async function addFile(kind, file) {
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${kind}/${Date.now()}-${safe}`;
  if (sb) {
    const { error } = await sb.storage.from("audio").upload(path, file, { contentType: file.type || "audio/mpeg", upsert: true });
    if (error) throw new Error(error.message);
  }
  await cachePut(path, file);
  return { name: file.name, path };
}
export async function removeFile(path) {
  if (sb) await sb.storage.from("audio").remove([path]);
}
export async function getBlob(path) {
  const c = await cacheGet(path);
  if (c) return c;
  if (!sb) return null;
  const { data, error } = await sb.storage.from("audio").download(path);
  if (error) throw new Error(error.message);
  await cachePut(path, data);
  return data;
}
