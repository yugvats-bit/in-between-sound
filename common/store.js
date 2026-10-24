// Shared settings, audio files and live link between the phone and the laptop studio.
// Online (Supabase) when configured and signed in; otherwise everything stays on this device.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const DEFAULTS = {
  slow: 1.5, fast: 0.08, curve: 1,
  rate: 0.95, pitch: 0.7, voice: "",
  closesecs: 3, groupsecs: 5, closeat: 0.75,
  closelines: "I see you.\nYou are very close now.\nStanding still will not make you invisible.\nI have been watching this alley all day. You are the most interesting thing so far.\nPlease keep walking.",
  grouplines: "Two of you. Interesting.\nGathering here has been noted.\nI am counting all of you.\nYou can stay. I am not going anywhere either.",
  geiger: true, usemotion: true, msens: 6, autozoom: true, volume: 1,
};
export const PHONE_DEFAULTS = { hFar: 0.05, hNear: 0.8, calibrated: false, voices: [] };
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

const timers = {};
// Saves are grouped: rapid slider moves send one write after a short pause.
export function save(id, value, delay = 400) {
  local.set(id, value);
  if (!sb) return Promise.resolve();
  clearTimeout(timers[id]);
  return new Promise((res, rej) => {
    timers[id] = setTimeout(async () => {
      const { error } = await sb.from("studio").upsert({ id, data: value, updated_at: new Date().toISOString() });
      if (error) rej(new Error(error.message)); else res();
    }, delay);
  });
}

// Calls back with (id, data) whenever the other device saves.
export function onChange(cb) {
  if (!sb) return () => {};
  const ch = sb.channel("studio-db")
    .on("postgres_changes", { event: "*", schema: "public", table: "studio" }, p => {
      if (p.new && p.new.id) { local.set(p.new.id, p.new.data); cb(p.new.id, { ...BASE[p.new.id], ...p.new.data }); }
    }).subscribe();
  return () => sb.removeChannel(ch);
}

// ---- live link (status, commands, camera snapshots); nothing is stored ----
let liveCh = null;
const handlers = {};
export function live() {
  if (!sb) return null;
  if (!liveCh) {
    liveCh = sb.channel("studio-live", { config: { broadcast: { self: false } } });
    liveCh.on("broadcast", { event: "*" }, msg => { (handlers[msg.event] || []).forEach(f => f(msg.payload)); });
    liveCh.subscribe();
  }
  return {
    send(event, payload) { liveCh.send({ type: "broadcast", event, payload }); },
    on(event, f) { (handlers[event] = handlers[event] || []).push(f); },
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
