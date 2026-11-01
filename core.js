// Always Green — core logic (no browser APIs here, so it can be unit-tested in Node).
// 1. Geometry helpers
// 2. Learner: infers each light's fixed-time plan (cycle, green start, green length)
//    from your own drives. Public data only: nothing comes from the city.
// 3. Advisor: the speed model from glosa.py / the simulator.

export const MPH = 0.44704;
export const YELLOW = 4;          // assumed yellow time, s

// ---------- 1. geometry ----------
const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
export function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
export const sectorOf = h => Math.round(((h % 360) + 360) % 360 / 45) % 8;

// Group signal nodes that belong to one intersection (OSM often maps 2–4 per junction).
export function clusterSignals(nodes, radius = 35) {
  const out = [];
  for (const n of nodes) {
    const c = out.find(c => dist(c, n) < radius);
    if (c) { c.members++; c.lat += (n.lat - c.lat) / c.members; c.lon += (n.lon - c.lon) / c.members; }
    else out.push({ id: String(n.id), lat: n.lat, lon: n.lon, members: 1 });
  }
  return out;
}

// Lights ahead of the car, nearest first. Straight-line projection along the heading.
export function lightsAhead(pos, heading, clusters, maxDist = 1200, maxAngle = 25) {
  const res = [];
  for (const c of clusters) {
    const d = dist(pos, c);
    if (d > maxDist || d < 1) continue;
    const ang = Math.abs(angDiff(bearing(pos, c), heading));
    const lateral = d * Math.sin(rad(ang));
    if (ang > maxAngle && lateral > 30) continue;
    if (ang > 80) continue;
    res.push({ c, along: d * Math.cos(rad(ang)) });
  }
  return res.sort((a, b) => a.along - b.along);
}

// ---------- time helpers ----------
export function secOfDay(ms) { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000; }
// Signals usually switch timing plans by time of day and weekday/weekend.
export function planBucket(ms) {
  const d = new Date(ms), h = d.getHours(), we = d.getDay() === 0 || d.getDay() === 6;
  const p = h < 6 ? "night" : h < 9 ? "am" : h < 15 ? "mid" : h < 19 ? "pm" : h < 22 ? "eve" : "night";
  return (we ? "we-" : "wd-") + p;
}
const mod = (a, m) => ((a % m) + m) % m;
const wrap = (e, C) => { const x = mod(e, C); return x > C / 2 ? x - C : x; };

// ---------- 2. learner ----------
// Observation types, all times in seconds since local midnight:
//   G {t, sigma}  green started at t (you were stopped at the light and pulled away)
//   P {t}         you passed the stop line at t without stopping (green or yellow then)
//   R {a, b}      you sat at red from a until b
// Assumption: the light runs a fixed-time plan whose cycle counter is anchored to the
// clock (true of most coordinated fixed-time signals). Actuated lights won't fit well,
// and the fit statistics say so.
export function fitApproach(allObs, bucket) {
  let obs = allObs.filter(o => o.bucket === bucket);
  let pooled = false;
  if (obs.filter(o => o.type === "G").length < 2) { obs = allObs; pooled = true; }
  const G = obs.filter(o => o.type === "G"), P = obs.filter(o => o.type === "P"), Rr = obs.filter(o => o.type === "R");
  if (!G.length) return null;

  const cands = [];
  for (let C = 50; C <= 180; C += 0.5) {
    let sx = 0, sy = 0;
    for (const g of G) { const a = 2 * Math.PI * mod(g.t, C) / C, w = 1 / (g.sigma * g.sigma); sx += w * Math.cos(a); sy += w * Math.sin(a); }
    let phi = mod(Math.atan2(sy, sx) / (2 * Math.PI) * C, C);
    let ll = 0, ss = 0;
    for (const g of G) { const e = wrap(g.t - phi, C); ll -= 0.5 * (e * e) / (g.sigma * g.sigma); ss += e * e; }
    let gMin = 10, gMax = C - 12;
    for (const p of P) gMin = Math.max(gMin, mod(p.t - phi, C) - YELLOW);
    for (const r of Rr) gMax = Math.min(gMax, mod(r.a - phi, C) - YELLOW);
    if (gMin > gMax) ll -= 0.5 * ((gMin - gMax) / 3) ** 2;           // contradictions cost
    ll -= 0.5 * ((C - 100) / 30) ** 2;                               // prior: most cycles 70–130 s
    if (C % 5 === 0) ll += 0.3;                                      // engineers like round cycles
    cands.push({ C, phi, ll, gMin, gMax, rms: Math.sqrt(ss / G.length) });
  }
  const mx = Math.max(...cands.map(c => c.ll));
  let tot = 0; for (const c of cands) { c.p = Math.exp(c.ll - mx); tot += c.p; }
  const best = cands.reduce((a, b) => (b.p > a.p ? b : a));
  const peak = cands.filter(c => Math.abs(c.C - best.C) <= 1.5).reduce((s, c) => s + c.p, 0) / tot;
  const n = G.length;
  const green = Math.max(best.gMin, Math.min(best.gMax, 0.45 * best.C));
  let sigma = n < 2 ? 10 : Math.min(15, Math.max(1, best.rms) * (1 + 3 * (1 - peak)) + (n < 4 ? 2 : 0));
  const conf = n >= 6 && peak > 0.6 && best.rms < 2.5 && !pooled ? "Sure" : n >= 3 && peak > 0.3 ? "Likely" : "Guess";
  return { C: best.C, phi: best.phi, green, sigma, conf, n, peak, rms: best.rms, pooled, consistent: best.gMin <= best.gMax };
}

// Predicted green windows relative to now (seconds), from a fitted plan.
export function predictWindows(plan, nowMs) {
  const s = secOfDay(nowMs);
  const last = s - mod(s - plan.phi, plan.C);
  const out = [];
  for (let k = -1; k <= 4; k++) {
    const gs = last + k * plan.C - s, ge = gs + plan.green;
    if (ge > 0) out.push([gs, ge]);
  }
  return out;
}

// Turns a pass through one light approach into observations.
// track: [{t(ms), d(along-track metres to stop area, + = before), v(m/s)}] for that approach.
export function observationsFromPass(track, bucket) {
  const obs = [];
  let stopStart = null, stopDist = null, go = null;
  for (const p of track) {
    if (p.d < 60 && p.d > -5 && p.v < 0.8) { if (stopStart === null) { stopStart = p.t; stopDist = p.d; } }
    else if (stopStart !== null && go === null && p.v > 1.5) {
      if (p.t - stopStart >= 2000) go = p.t; else stopStart = null;
    }
  }
  const passed = track.find(p => p.d < 0);
  if (!passed) return obs;
  if (go !== null) {
    const queue = Math.max(0, (stopDist - 12) / 7.5);               // cars ahead of you (approx.)
    if (queue <= 4) {
      const gStart = go - 1500 - queue * 2000;
      obs.push({ type: "G", t: secOfDay(gStart), sigma: 2 + queue, bucket, at: gStart });
      obs.push({ type: "R", a: secOfDay(stopStart), b: secOfDay(gStart), bucket, at: stopStart });
    }
  } else if (stopStart === null && passed.v > 3) {
    obs.push({ type: "P", t: secOfDay(passed.t), bucket, at: passed.t });
  }
  return obs;
}

// ---------- 3. advisor ----------
export const MODES = {
  // "Advise right away": speaks even on weak guesses, labelled as such.
  eager:   { aAcc: 1.5, aDec: 1.0, kSigma: 0.5, endBuffer: 1.0, pMin: 0.5, maxSigma: 12, floorFrac: 0.6, floorAbs: 15 * MPH },
  careful: { aAcc: 1.5, aDec: 1.0, kSigma: 1.5, endBuffer: 1.0, pMin: 0.8, maxSigma: 3,  floorFrac: 0.6, floorAbs: 15 * MPH },
};
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const phiN = x => 0.5 * (1 + erf(x / Math.SQRT2));
export function travelTime(d, v0, v, p) {
  if (v <= 0) return Infinity;
  const a = v > v0 ? p.aAcc : p.aDec, tch = Math.abs(v - v0) / a, dch = (v0 + v) / 2 * tch;
  if (dch >= d) { const s = v > v0 ? 1 : -1, disc = v0 * v0 + 2 * s * a * d; return disc < 0 ? Infinity : (-v0 + Math.sqrt(disc)) / (s * a); }
  return tch + (d - dch) / v;
}
function speedFor(d, v0, tt, p, lo, hi) { for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (travelTime(d, v0, m, p) > tt) lo = m; else hi = m; } return (lo + hi) / 2; }
function intervals(s, v0, p, lo, hi) {
  const b = p.kSigma * s.sigma, tF = travelTime(s.dist, v0, hi, p), tS = travelTime(s.dist, v0, lo, p), out = [];
  for (const [gs, ge] of s.greens) {
    const a = Math.max(gs + b, tF), z = Math.min(ge - p.endBuffer - b, tS);
    if (a <= z) out.push([speedFor(s.dist, v0, z, p, lo, hi), speedFor(s.dist, v0, a, p, lo, hi)]);
  }
  return out;
}
const pGreen = (s, t) => Math.max(0, ...s.greens.map(([gs, ge]) => phiN((t - gs) / s.sigma) * phiN((ge - t) / s.sigma)));

// sigs: [{dist(m to stop line), greens:[[gs,ge]...], sigma}], nearest first.
// vCap: the highest speed we may ever advise (speed limit, or current speed if limit unknown).
export function advise(sigs, v0, vCap, vLimitForFloor, p) {
  const vFloor = Math.max(p.floorFrac * vLimitForFloor, p.floorAbs), first = sigs[0];
  if (vCap < vFloor + 0.5) return { mode: "SILENT", why: "slow" };
  if (first.sigma > p.maxSigma) return { mode: "SILENT", why: "uncertain" };
  if (!intervals(first, v0, p, vFloor, vCap).length) {
    if (intervals(first, v0, { ...p, kSigma: 0 }, vFloor, vCap).length) return { mode: "SILENT", why: "uncertain" };
    return { mode: "EASE" };
  }
  let feas = [[vFloor, vCap]], chained = 0;
  for (const s of sigs) {
    const iv = intervals(s, v0, p, vFloor, vCap), nw = [];
    for (const [a, b] of feas) for (const [c, d] of iv) { const lo = Math.max(a, c), hi = Math.min(b, d); if (lo <= hi) nw.push([lo, hi]); }
    if (!nw.length) break;
    feas = nw; chained++;
  }
  const v = Math.max(...feas.map(f => f[1]));                       // fastest allowed speed
  const pg = pGreen(first, travelTime(first.dist, v0, v, p));
  if (pg < p.pMin) return { mode: "SILENT", why: "uncertain", pg };
  return { mode: "HOLD", v, pg, chained };
}

// Parse OSM maxspeed ("35 mph", "50", "none", "signals") -> m/s or null
export function parseMaxspeed(s) {
  if (!s) return null;
  const m = String(s).match(/^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return (m[2] && m[2].toLowerCase() === "mph") ? n * MPH : n / 3.6;
}
