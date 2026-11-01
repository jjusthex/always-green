// Always Green — iPhone web app
import * as core from "./core.js";
const { MPH } = core;
const $ = s => document.querySelector(s);

// ---------- storage (stays on this phone) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("ag." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ag." + k, JSON.stringify(v)); } catch (e) { console.warn("storage full?", e); } },
};
const settings = Object.assign({ accepted: false, voice: true, onlyConfident: false, unknownLimit: "slowOnly" }, store.get("settings", {}));
let obsDB = store.get("obs", {});                      // approachKey -> [observation]
let sigCache = store.get("signals", { nodes: {}, tiles: {} });
let accuracy = store.get("acc", []);                   // |prediction error| in s, newest last
let drives = store.get("drives", []);                  // drive summaries
const saveSettings = () => store.set("settings", settings);

// ---------- screens ----------
function show(id) { document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === id)); }
function refreshHome() {
  const keys = Object.keys(obsDB).filter(k => obsDB[k].some(o => o.type === "G"));
  let sure = 0;
  const b = core.planBucket(Date.now());
  for (const k of keys) { const f = core.fitApproach(obsDB[k], b); if (f && f.conf === "Sure") sure++; }
  $("#stLights").textContent = keys.length;
  $("#stSure").textContent = sure;
  $("#stDrives").textContent = drives.length;
  const recent = accuracy.slice(-20).slice().sort((a, b) => a - b);
  $("#stAcc").textContent = recent.length ? "±" + recent[Math.floor(recent.length / 2)].toFixed(1) + " s" : "—";
  $("#setVoice").checked = settings.voice;
  $("#setConf").checked = settings.onlyConfident;
  $("#setLimit").value = settings.unknownLimit;
}
$("#accept").onclick = () => { settings.accepted = true; saveSettings(); refreshHome(); show("home"); };
$("#setVoice").onchange = e => { settings.voice = e.target.checked; saveSettings(); };
$("#setConf").onchange = e => { settings.onlyConfident = e.target.checked; saveSettings(); };
$("#setLimit").onchange = e => { settings.unknownLimit = e.target.value; saveSettings(); };

// ---------- OpenStreetMap (public data): signal locations and speed limits ----------
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
async function overpass(q, timeoutMs = 20000) {
  for (const url of OVERPASS) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ac.signal });
      clearTimeout(to);
      if (r.ok) return await r.json();
    } catch { clearTimeout(to); }
  }
  throw new Error("map data unavailable");
}
const tileKey = p => Math.round(p.lat / 0.02) + ":" + Math.round(p.lon / 0.02);
let fetchingTile = null;
async function ensureSignals(pos) {
  const key = tileKey(pos), t = sigCache.tiles[key];
  if ((t && Date.now() - t < 14 * 864e5) || fetchingTile === key) return;
  fetchingTile = key;
  try {
    const q = `[out:json][timeout:25];node["highway"="traffic_signals"](${(pos.lat - 0.03).toFixed(4)},${(pos.lon - 0.04).toFixed(4)},${(pos.lat + 0.03).toFixed(4)},${(pos.lon + 0.04).toFixed(4)});out;`;
    const j = await overpass(q);
    for (const n of j.elements || []) sigCache.nodes[n.id] = { id: n.id, lat: +n.lat.toFixed(6), lon: +n.lon.toFixed(6) };
    sigCache.tiles[key] = Date.now();
    store.set("signals", sigCache);
    if (S && !S.demo) S.clusters = core.clusterSignals(Object.values(sigCache.nodes));
  } catch { msg("Couldn't load traffic light locations. Retrying…"); sigCache.tiles[key] = Date.now() - 14 * 864e5 + 60e3; }
  finally { fetchingTile = null; }
}
let limitBusy = false;
async function updateLimit() {
  if (!S || S.demo || limitBusy || !S.pos) return;
  if (S.limit.pos && core.dist(S.limit.pos, S.pos) < 250 && Date.now() - S.limit.at < 60e3) return;
  limitBusy = true;
  const p = { ...S.pos };
  try {
    const j = await overpass(`[out:json][timeout:10];way(around:25,${p.lat.toFixed(6)},${p.lon.toFixed(6)})["highway"]["maxspeed"];out tags;`, 12000);
    const ways = (j.elements || []).filter(w => !/footway|cycleway|path|service/.test(w.tags.highway));
    const v = ways.length ? core.parseMaxspeed(ways[0].tags.maxspeed) : null;
    S && (S.limit = { v, at: Date.now(), pos: p });
  } catch { S && (S.limit = { v: S.limit.v, at: Date.now(), pos: p }); }
  finally { limitBusy = false; }
}

// ---------- voice ----------
let lastSaid = "", lastSayAt = 0;
function say(text, force = false) {
  if (!settings.voice || (S && S.muted) || !("speechSynthesis" in window)) return;
  const now = Date.now();
  if (!force && (text === lastSaid || now - lastSayAt < 6000)) return;
  lastSaid = text; lastSayAt = now;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u); } catch {}
}

// ---------- screen wake lock ----------
let wake = null;
async function keepAwake() { try { if ("wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (S && document.visibilityState === "visible") keepAwake(); });

// ---------- drive session ----------
let S = null;
const now = () => (S && S.demo ? S.clock : Date.now());
function msg(t) { const el = S ? $("#driveMsg") : $("#homeMsg"); if (el) el.textContent = t; }

function newSession(demo) {
  return {
    demo, startMs: Date.now(), clock: Date.now(), pos: null, v: 0, h: null, acc: 99, lastFixT: 0, lastHeadPos: null,
    clusters: demo ? [] : core.clusterSignals(Object.values(sigCache.nodes)), tracking: null, fitCache: {},
    limit: { v: null, at: 0, pos: null }, muted: false, mode: null, lastMph: null, shownMph: null,
    obsDB: demo ? {} : obsDB, track: [], stats: { passes: 0, stops: 0, newObs: 0, learnedNew: 0 }, saidLearning: false,
  };
}

async function startDrive(demo = false) {
  S = newSession(demo);
  show("drive");
  $("#driveBrand").textContent = demo ? "Demo drive" : "Always Green";
  $("#mute").textContent = "Mute";
  say(demo ? "Demo drive started." : "Always Green started.", true);   // unlocks speech on iPhone
  keepAwake();
  render({ mode: "WAIT" });
  if (demo) { startDemo(); }
  else {
    if (!("geolocation" in navigator)) { msg("This browser has no GPS access."); return; }
    S.watchId = navigator.geolocation.watchPosition(onPosition, e => {
        if (!S) return;
        S.geoError = e.code;                                   // 1 = blocked, 2 = unavailable, 3 = slow
        if (!S.pos) render({ mode: "WAIT" });
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  S.timer = setInterval(tick, 1000);
}
$("#start").onclick = () => startDrive(false);
$("#demo").onclick = () => startDrive(true);
$("#mute").onclick = () => { if (!S) return; S.muted = !S.muted; $("#mute").textContent = S.muted ? "Unmute" : "Mute"; if (S.muted) try { speechSynthesis.cancel(); } catch {} };
$("#stop").onclick = endDrive;

function onPosition(p) {
  const c = p.coords;
  onFix({ t: p.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, speed: c.speed, heading: c.heading, acc: c.accuracy });
}

function onFix(f) {
  if (!S) return;
  const pos = { lat: f.lat, lon: f.lon };
  // speed
  let v = (f.speed !== null && f.speed !== undefined && f.speed >= 0) ? f.speed : null;
  if (v === null && S.pos && f.t > S.lastFixT) v = core.dist(S.pos, pos) / ((f.t - S.lastFixT) / 1000);
  S.v = v === null ? S.v : Math.min(v, 60);
  // heading: GPS course when moving, else bearing between fixes, else keep the last one
  if (f.heading !== null && f.heading !== undefined && !isNaN(f.heading) && f.heading >= 0 && S.v > 1.5) S.h = f.heading;
  else if (S.lastHeadPos && core.dist(S.lastHeadPos, pos) > 8) { S.h = core.bearing(S.lastHeadPos, pos); }
  if (!S.lastHeadPos || core.dist(S.lastHeadPos, pos) > 8) S.lastHeadPos = pos;
  S.pos = pos; S.acc = f.acc; S.lastFixT = f.t;
  if (S.demo) S.clock = f.t;
  if (!S.demo) { ensureSignals(pos); updateLimit(); }
  if (!S.track.length || f.t - S.track[S.track.length - 1][0] >= 1000)
    S.track.push([f.t, +pos.lat.toFixed(5), +pos.lon.toFixed(5), +S.v.toFixed(1)]);
  if (!S.firstFixShown) { S.firstFixShown = true; S.geoError = null; tick(); }
  if (S.h === null) return;
  trackLight(f.t);
}

// Follow one light approach from ~400 m out until we're past it, then learn from it.
function trackLight(t) {
  const T = S.tracking;
  if (T) {
    const d0 = core.dist(S.pos, T.c), ang = core.angDiff(core.bearing(S.pos, T.c), T.h0) * Math.PI / 180;
    const along = d0 * Math.cos(ang), lateral = Math.abs(d0 * Math.sin(ang));
    if (along > 15 && lateral > 45) { S.tracking = null; return; }          // turned off before the light
    T.track.push({ t, d: along - 12, v: S.v });
    T.along = along;
    if (S.v < 0.8 && along - 12 < 60 && T.predAtStop === undefined) {     // remember what we predicted, to score ourselves
      const plan = fitFor(T.key);
      const w = plan && core.predictWindows(plan, now()).find(x => x[0] > -2);
      T.predAtStop = w ? now() + w[0] * 1000 : -1;
    }
    if (along < -25) finishLight(T);
    return;
  }
  if (S.v > 2) {
    const f = core.lightsAhead(S.pos, S.h, S.clusters, 400).find(a => a.along > 30);
    if (f) S.tracking = { c: f.c, h0: S.h, key: f.c.id + ":" + core.sectorOf(S.h), track: [], along: f.along };
  }
}
function finishLight(T) {
  S.tracking = null;
  if (T.track.length < 5) return;
  const obs = core.observationsFromPass(T.track, core.planBucket(T.track[0].t));
  S.stats.passes++;
  if (!obs.length) return;
  const db = S.obsDB, had = (db[T.key] || []).some(o => o.type === "G");
  db[T.key] = (db[T.key] || []).concat(obs).slice(-200);
  S.stats.newObs += obs.length;
  if (obs.some(o => o.type === "G")) { S.stats.stops++; if (!had) S.stats.learnedNew++; }
  delete S.fitCache[T.key];
  const g = obs.find(o => o.type === "G");
  if (g && T.predAtStop > 0 && !S.demo) { accuracy.push(Math.abs(g.at - T.predAtStop) / 1000); accuracy = accuracy.slice(-200); store.set("acc", accuracy); }
  if (!S.demo) store.set("obs", obsDB);
}
function fitFor(key) {
  if (!(key in S.fitCache)) S.fitCache[key] = S.obsDB[key] ? core.fitApproach(S.obsDB[key], core.planBucket(now())) : null;
  return S.fitCache[key];
}

// ---------- advice, once a second ----------
function tick() {
  if (!S) return;
  if (!S.pos) return render({ mode: "WAIT" });
  if (S.acc > 40) return render({ mode: "GPS" });
  if (S.h === null) return render({ mode: "READY" });       // have a fix, but not moving yet
  const T = S.tracking;
  if (T && S.v < 0.8 && T.along - 12 < 40) {                              // waiting at a red
    const plan = fitFor(T.key);
    const w = plan && core.predictWindows(plan, now()).find(x => x[0] > 0);
    return render({ mode: "STOPPED", secs: w ? w[0] : null, plan });
  }
  const ahead = core.lightsAhead(S.pos, S.h, S.clusters, 1200).filter(a => a.along - 12 > 15).slice(0, 2);
  if (!ahead.length) return render({ mode: "NONE" });
  const sigs = [];
  for (const a of ahead) {
    const plan = fitFor(a.c.id + ":" + core.sectorOf(S.h));
    if (!plan) break;
    sigs.push({ dist: a.along - 12, greens: core.predictWindows(plan, now()), sigma: plan.sigma, plan });
  }
  if (!sigs.length) return render({ mode: "LEARNING", dist: ahead[0].along - 12 });
  // speed ceiling: the limit if known; otherwise never faster than you're going now
  let vCap, vBase;
  if (S.limit.v) { vCap = vBase = S.limit.v; }
  else if (settings.unknownLimit !== "slowOnly") { vCap = vBase = (+settings.unknownLimit) * MPH; }
  else { vCap = vBase = S.v; }
  const params = settings.onlyConfident ? core.MODES.careful : core.MODES.eager;
  const r = core.advise(sigs, S.v, vCap, vBase, params);
  render({ ...r, dist: sigs[0].dist, conf: sigs[0].plan.conf });
}

const CONF_BARS = { Guess: 1, Likely: 2, Sure: 3 };
function render(a) {
  const band = $("#band"), big = $("#big"), unit = $("#unit"), sub = $("#sub");
  const setBand = (text, color, fill) => { band.textContent = text; band.style.borderColor = color; band.style.background = fill; };
  const lim = S.limit.v ? Math.round(S.limit.v / MPH) : (settings.unknownLimit !== "slowOnly" ? settings.unknownLimit : "?");
  $("#limitVal").textContent = lim;
  $("#speedNow").textContent = Math.round(S.v / MPH) + " mph";
  $("#nextDist").textContent = a.dist !== undefined ? fmtDist(a.dist) : (S.tracking ? fmtDist(Math.max(0, S.tracking.along - 12)) : "—");
  $("#conf").textContent = a.conf || (a.plan && a.plan.conf) || "—";
  big.classList.add("text"); unit.textContent = ""; sub.textContent = "";
  switch (a.mode) {
    case "WAIT":
      if (S.geoError === 1) {
        setBand("Location is blocked", "#FFB547", "rgba(255,181,71,.16)"); big.textContent = "Allow location";
        sub.textContent = "Settings › Privacy & Security › Location Services › Safari Websites › While Using, and turn on Precise Location. Then end and restart the drive.";
      } else if (S.geoError === 2) {
        setBand("Location unavailable", "#FFB547", "rgba(255,181,71,.16)"); big.textContent = "No GPS";
        sub.textContent = "Check that Location Services is on, and that you opened the https:// link.";
      } else {
        setBand("Finding GPS…", "#6B7684", "#151B23"); big.textContent = "—";
        sub.textContent = S.geoError === 3 ? "Still waiting for a fix. Try near a window or outside." : "If Safari asks, tap Allow.";
      }
      break;
    case "GPS":
      setBand("Weak GPS signal", "#6B7684", "#151B23"); big.textContent = "—";
      sub.textContent = `Accuracy ±${Math.round(S.acc)} m. ` + (S.acc > 500 ? "Turn on Precise Location for Safari Websites in Settings." : "No advice until GPS improves.");
      break;
    case "READY":
      setBand("GPS ready", "#3DDC84", "rgba(61,220,132,.16)"); big.textContent = "Start driving";
      sub.textContent = `Accuracy ±${Math.round(S.acc)} m · ${S.clusters.length} lights loaded nearby. Advice starts once you're moving.`;
      break;
    case "NONE": setBand("No lights ahead", "#6B7684", "#151B23"); big.textContent = "—"; sub.textContent = "Drive normally"; break;
    case "LEARNING":
      setBand("Learning this light", "#6B7684", "#151B23"); big.textContent = "Drive normally";
      sub.textContent = "Each pass teaches the app its timing";
      if (!S.saidLearning) { say("New light. Learning its timing."); S.saidLearning = true; }
      break;
    case "STOPPED":
      setBand("Stopped at red", "#4FC3F7", "rgba(79,195,247,.16)");
      if (a.secs !== null && a.secs > 4 && a.plan && a.plan.conf !== "Guess") { big.classList.remove("text"); big.textContent = Math.round(a.secs); unit.textContent = "seconds to green (" + a.plan.conf.toLowerCase() + ")"; }
      else { big.textContent = "Wait for green"; sub.textContent = a.plan ? "" : "Learning this light's timing"; }
      break;
    case "SILENT": setBand("No advice for this light", "#6B7684", "#151B23"); big.textContent = "Drive normally"; sub.textContent = a.why === "slow" ? "Speed limit unknown here" : "Timing too uncertain"; break;
    case "EASE":
      setBand(a.conf === "Guess" ? "Probably red ahead" : "Red ahead", "#FFB547", "rgba(255,181,71,.16)");
      big.textContent = "Ease off"; sub.textContent = "No need to hurry";
      if (S.mode !== "EASE") say(a.conf === "Guess" ? "Probably red ahead. Ease off." : "Red ahead. Ease off.");
      break;
    case "HOLD": {
      let mph = Math.round(a.v / MPH);
      if (S.mode === "HOLD" && S.shownMph !== null && Math.abs(mph - S.shownMph) < 2) mph = S.shownMph;   // no flicker
      setBand(a.conf === "Guess" ? "Guess: try this speed" : "Hold for the green", "#3DDC84", "rgba(61,220,132,.16)");
      big.classList.remove("text"); big.textContent = mph; unit.textContent = "mph";
      sub.textContent = a.chained > 1 ? a.chained + " lights in a row" : "";
      if (S.mode !== "HOLD" || S.lastMph === null || Math.abs(mph - S.lastMph) >= 3) {
        say(a.conf === "Sure" ? `Hold ${mph} for the green.` : a.conf === "Likely" ? `${mph} should make the green.` : `Guess: try ${mph}.`);
        S.lastMph = mph;
      }
      S.shownMph = mph;
      break;
    }
  }
  if (a.mode !== "HOLD") { S.lastMph = null; S.shownMph = null; }
  S.mode = a.mode;
}
function fmtDist(m) { const mi = m / 1609.34; return mi >= 0.1 ? mi.toFixed(2) + " mi" : Math.max(0, Math.round(m / 0.3048 / 10) * 10) + " ft"; }

function endDrive() {
  if (!S) return;
  if (S.watchId !== undefined) navigator.geolocation.clearWatch(S.watchId);
  clearInterval(S.timer); if (S.demoTimer) clearInterval(S.demoTimer);
  try { wake && wake.release(); } catch {}
  try { speechSynthesis.cancel(); } catch {}
  const st = S.stats, mins = (now() - S.startMs) / 60000;
  if (!S.demo && S.track.length > 30) {
    drives.push({ start: S.startMs, mins: +mins.toFixed(1), passes: st.passes, stops: st.stops, newObs: st.newObs });
    drives = drives.slice(-500); store.set("drives", drives);
    const tracks = store.get("tracks", []); tracks.push({ start: S.startMs, pts: S.track }); store.set("tracks", tracks.slice(-15));
  }
  $("#sumBody").innerHTML = S.demo
    ? `<p>That was a simulated drive on made-up lights. Nothing was saved. On a real drive, the app learns from every light you stop at or pass.</p>`
    : `<p><b style="color:#F2F5F7">${st.passes}</b> lights passed · <b style="color:#F2F5F7">${st.stops}</b> stops it learned from · <b style="color:#F2F5F7">${st.learnedNew}</b> new lights started.</p><p style="margin-top:8px">The more often you drive the same route, the sooner its lights reach "Sure".</p>`;
  S = null;
  show("summary");
}
$("#sumOk").onclick = () => { refreshHome(); show("home"); };

// ---------- backup ----------
$("#export").onclick = async () => {
  const data = JSON.stringify({ app: "always-green", version: 1, exported: new Date().toISOString(), obs: obsDB, drives, accuracy, tracks: store.get("tracks", []) });
  const file = new File([data], "always-green-backup.json", { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Always Green backup" }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
};
$("#import").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== "always-green") throw 0;
    for (const [k, list] of Object.entries(j.obs || {})) {
      const seen = new Set((obsDB[k] || []).map(o => o.type + o.at));
      obsDB[k] = (obsDB[k] || []).concat(list.filter(o => !seen.has(o.type + o.at))).slice(-200);
    }
    store.set("obs", obsDB);
    if (Array.isArray(j.drives) && j.drives.length > drives.length) { drives = j.drives; store.set("drives", drives); }
    $("#homeMsg").textContent = "Backup restored.";
  } catch { $("#homeMsg").textContent = "That file isn't an Always Green backup."; }
  refreshHome();
};
$("#wipe").onclick = () => {
  const b = $("#wipe");
  if (b.dataset.armed) { obsDB = {}; drives = []; accuracy = []; ["obs", "drives", "acc", "tracks"].forEach(k => store.set(k, k === "obs" ? {} : [])); b.textContent = "Erase all data"; delete b.dataset.armed; $("#homeMsg").textContent = "All learned data erased."; refreshHome(); }
  else { b.dataset.armed = "1"; b.textContent = "Tap again to erase"; setTimeout(() => { b.textContent = "Erase all data"; delete b.dataset.armed; }, 4000); }
};

// ---------- demo drive: made-up street, lights already learned, runs at 2× speed ----------
function startDemo() {
  const base = { lat: 42.3, lon: -83.2 };
  const at = m => ({ lat: base.lat + m / 111320, lon: base.lon });
  const truth = [500, 950, 1450].map((m, i) => ({ c: { id: "demo" + i, ...at(m) }, m, C: 90, phi: Math.random() * 90, G: 45 }));
  S.clusters = truth.map(x => x.c);
  S.limit = { v: 40 * MPH, at: Infinity, pos: base };
  const bucket = core.planBucket(S.clock);
  for (const x of truth) S.obsDB[x.c.id + ":0"] = Array.from({ length: 6 }, (_, k) => ({ type: "G", t: x.phi + k * x.C, sigma: 1.5, bucket, at: 0 }));
  const lightState = (x, ms) => { const ph = ((core.secOfDay(ms) - x.phi) % x.C + x.C) % x.C; return ph < x.G ? "G" : ph < x.G + 4 ? "Y" : "R"; };
  let m = 0, v = 0;
  S.demoTimer = setInterval(() => {
    if (!S) return;
    for (let i = 0; i < 2; i++) {                       // 2 × 0.25 s per 0.25 s real time
      S.clock += 250;
      // the demo driver follows the advice, and always obeys the real light
      let target = 40 * MPH;
      if (S.mode === "HOLD" && S.shownMph) target = S.shownMph * MPH;
      const next = truth.find(x => x.m - 12 > m);
      let brake = false;
      if (next) {
        const d = next.m - 12 - m, st = lightState(next, S.clock);
        if (st !== "G" && !(st === "Y" && v * v / 6 > d) && d < v * v / 2 + 25) brake = true;
        if (brake) v = Math.max(0, v - Math.min(6, v * v / (2 * Math.max(d, 0.5))) * 0.25);
      }
      if (!brake) v = v < target ? Math.min(target, v + 1.5 * 0.25) : Math.max(target, v - 1.0 * 0.25);
      m += v * 0.25;
    }
    onFix({ t: S.clock, ...at(m), speed: v, heading: 0, acc: 5 });
    if (m > 1750) { say("Demo complete.", true); setTimeout(endDrive, 1200); clearInterval(S.demoTimer); }
  }, 250);
}

// ---------- boot ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
refreshHome();
show(settings.accepted ? "home" : "safety");
window.__ag = { core, get S() { return S; }, onFix };
