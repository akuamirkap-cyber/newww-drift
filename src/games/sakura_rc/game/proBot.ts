/* ==========================================================================
 * SAKURA RC PRO — PRO DRIFT BOT v2  ("Smooth Pro Line Driver")
 * --------------------------------------------------------------------------
 * Mesin AI baru untuk bot RC 1:10 di sirkuit Sakura / Haruna.
 *
 * Masalah versi lama yang diperbaiki di sini:
 *   1. Gerakan kaku & "lag"  -> dulu heading & velocityAngle di-lerp mentah
 *      pakai dt (frame-rate dependent, sudut menjejak kasar). Sekarang semua
 *      aktuator memakai integrator orde-2 (spring-damper) + batas akselerasi
 *      lateral & jerk, plus substepping 120 Hz => halus walau frame drop.
 *   2. Selalu mepet pembatas -> dulu offset lateral target = 0.48 * lebar
 *      track ke arah luar terus, plus clamp dinding dadakan. Sekarang
 *      LanePlan membuat garis balap out-in-out (apex) dengan margin dinding
 *      aman + tekanan dinding prediktif (bukan clamp mendadak).
 *   3. Tabrakan kasar -> dulu impuls minimum dipaksa 2.6..14.5 m/s & separasi
 *      54% sekali jalan (mobil mental). Sekarang solver kontinu: separasi
 *      dibatasi kecepatan (m/s), impuls murni dari kecepatan mendekat,
 *      friksi tangensial, spin terbatas => "senggol" tetap bisa, tapi mulus.
 *   4. Gampang ditebak -> tiap sesi punya personality (seed) + mood lambat +
 *      variasi garis tiap lap + feint manji di lurus.
 *   5. Keluar jalur -> mode RECOVER: titik rejoin dicari di depan dengan
 *      sudut masuk dibatasi, kecepatan & slip diturunkan, lalu blend balik ke
 *      garis secara mulus. Plus mode UNSTICK kalau mentok.
 * ========================================================================== */

import * as THREE from 'three';
import type { BotPace, ClippingZoneDef } from '../types/rcDrift';

/* ------------------------------------------------------------------ utils */

export const wrapPi = (a: number): number => {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
};

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const moveTowards = (cur: number, target: number, maxDelta: number): number => {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
};

export const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

/** Exponential smoothing yang tidak bergantung frame-rate. */
export const damp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Deterministic xorshift32 PRNG — perilaku bot konsisten antar frame. */
export const makeRng = (seed: number) => {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
};

/** Noise 1D halus (jumlah 3 sinus) untuk mood & wander — bukan random per frame. */
export class SmoothNoise {
  private readonly p1: number;
  private readonly p2: number;
  private readonly p3: number;
  constructor(seed: number) {
    const r = makeRng(seed);
    this.p1 = r() * 64;
    this.p2 = r() * 64;
    this.p3 = r() * 64;
  }
  at(x: number): number {
    return (
      0.53 * Math.sin(x * 0.63 + this.p1) +
      0.31 * Math.sin(x * 1.27 + this.p2) +
      0.16 * Math.sin(x * 2.11 + this.p3)
    );
  }
}

/* ---------------------------------------------------------- track sampler */

export interface TrackPoseSample {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  curvature: number;
  t: number;
  dist: number;
}

export interface TrackProjection {
  t: number;
  dist: number;
  lateral: number;
  tangentX: number;
  tangentZ: number;
  curvature: number;
  idx: number;
}

export const makeTrackPose = (): TrackPoseSample => ({
  x: 0,
  y: 0,
  z: 0,
  tx: 0,
  tz: 1,
  nx: -1,
  nz: 0,
  curvature: 0,
  t: 0,
  dist: 0,
});

export const makeTrackProjection = (): TrackProjection => ({
  t: 0,
  dist: 0,
  lateral: 0,
  tangentX: 0,
  tangentZ: 1,
  curvature: 0,
  idx: 0,
});

/**
 * Sampler spline precomputed (1x saat build) berisi posisi, tangent, normal,
 * kelengkungan + spatial hash 4 m untuk proyeksi O(1).
 * Menggantikan puluhan `curve.getPointAt()` per frame => bebas GC hitch.
 */
export class TrackSampler {
  readonly closed: boolean;
  readonly count: number;
  readonly length: number;
  readonly spacing: number;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly tx: Float32Array;
  private readonly tz: Float32Array;
  private readonly curv: Float32Array;
  private readonly cells = new Map<number, number[]>();
  private readonly cellSize = 4;

  constructor(curve: THREE.CatmullRomCurve3, opts: { closed: boolean; samples: number }) {
    this.closed = opts.closed;
    const divisions = Math.max(64, Math.floor(opts.samples));
    const spaced = curve.getSpacedPoints(divisions);
    const raw = this.closed ? spaced.slice(0, spaced.length - 1) : spaced;
    const n = Math.max(16, raw.length);
    this.count = n;

    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.curv = new Float32Array(n);
    const heading = new Float32Array(n);

    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = raw[i];
      this.px[i] = p.x;
      this.py[i] = p.y;
      this.pz[i] = p.z;
      if (i > 0) total += Math.hypot(p.x - raw[i - 1].x, p.z - raw[i - 1].z);
    }
    if (this.closed) total += Math.hypot(raw[0].x - raw[n - 1].x, raw[0].z - raw[n - 1].z);
    this.length = Math.max(1, total);
    this.spacing = this.length / n;

    for (let i = 0; i < n; i++) {
      const prev = this.wrapIdx(i - 1);
      const next = this.wrapIdx(i + 1);
      let dx = this.px[next] - this.px[prev];
      let dz = this.pz[next] - this.pz[prev];
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      this.tx[i] = dx;
      this.tz[i] = dz;
      heading[i] = Math.atan2(dx, dz);
    }

    for (let i = 0; i < n; i++) {
      const dh = wrapPi(heading[this.wrapIdx(i + 1)] - heading[this.wrapIdx(i - 1)]);
      this.curv[i] = dh / Math.max(0.08, this.spacing * 2);
    }
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        tmp[i] =
          this.curv[this.wrapIdx(i - 1)] * 0.25 +
          this.curv[i] * 0.5 +
          this.curv[this.wrapIdx(i + 1)] * 0.25;
      }
      this.curv.set(tmp);
    }

    const cs = this.cellSize;
    for (let i = 0; i < n; i++) {
      const key = TrackSampler.cellKey(Math.floor(this.px[i] / cs), Math.floor(this.pz[i] / cs));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i);
      else this.cells.set(key, [i]);
    }
  }

  private static cellKey(cx: number, cz: number): number {
    return (cx + 8192) * 65536 + (cz + 8192);
  }

  /** Index tetangga dengan wrap (closed) atau clamp (open / Haruna). */
  wrapIdx(i: number): number {
    if (this.closed) return ((i % this.count) + this.count) % this.count;
    return clamp(i, 0, this.count - 1);
  }

  curvatureAtIdx(i: number): number {
    return this.curv[this.wrapIdx(i)];
  }

  poseAtT(t: number, out: TrackPoseSample): TrackPoseSample {
    const tt = this.closed ? ((t % 1) + 1) % 1 : clamp(t, 0, 1);
    const fi = tt * this.count;
    const i0 = Math.floor(fi) % this.count;
    const i1 = this.closed ? (i0 + 1) % this.count : Math.min(this.count - 1, i0 + 1);
    const f = fi - Math.floor(fi);
    out.x = lerpN(this.px[i0], this.px[i1], f);
    out.y = lerpN(this.py[i0], this.py[i1], f);
    out.z = lerpN(this.pz[i0], this.pz[i1], f);
    let dx = lerpN(this.tx[i0], this.tx[i1], f);
    let dz = lerpN(this.tz[i0], this.tz[i1], f);
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    out.tx = dx;
    out.tz = dz;
    out.nx = -dz;
    out.nz = dx;
    out.curvature = lerpN(this.curv[i0], this.curv[i1], f);
    out.t = tt;
    out.dist = tt * this.length;
    return out;
  }

  poseAtDist(dist: number, out: TrackPoseSample): TrackPoseSample {
    const d = this.closed
      ? ((dist % this.length) + this.length) % this.length
      : clamp(dist, 0, this.length);
    return this.poseAtT(d / this.length, out);
  }

  curvatureAtT(t: number): number {
    const tt = this.closed ? ((t % 1) + 1) % 1 : clamp(t, 0, 1);
    const fi = tt * this.count;
    const i0 = Math.floor(fi) % this.count;
    const i1 = this.closed ? (i0 + 1) % this.count : Math.min(this.count - 1, i0 + 1);
    return lerpN(this.curv[i0], this.curv[i1], fi - Math.floor(fi));
  }

  curvatureAtDist(dist: number): number {
    return this.curvatureAtT(dist / this.length);
  }

  /**
   * Proyeksi posisi world ke spline: t, jarak lateral bertanda (konvensi
   * normal (-tz, tx) sama dengan clipping zone & dinding), tangent,
   * kelengkungan. `hintIdx` mengaktifkan fast-path lokal.
   */
  project(x: number, z: number, out: TrackProjection, hintIdx = -1): TrackProjection {
    let bestIdx = -1;
    let bestD2 = Infinity;

    if (hintIdx >= 0) {
      // Window adaptif: cukup untuk gerak per frame (~10 m) di track mana pun,
      // termasuk Haruna yang titik sampelnya ~2 m. Teleport tetap ditangani
      // oleh fallback grid di bawah.
      const win = clamp(Math.round(10 / Math.max(0.05, this.spacing)) + 6, 8, 48);
      for (let k = -win; k <= win; k++) {
        const i = this.wrapIdx(hintIdx + k);
        const dx = this.px[i] - x;
        const dz = this.pz[i] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0 || bestD2 > 49) {
      const g = this.gridSearch(x, z);
      if (g.d2 < bestD2) {
        bestD2 = g.d2;
        bestIdx = g.idx;
      }
    }
    if (bestIdx < 0) bestIdx = 0;

    let segA = bestIdx;
    let segB = this.wrapIdx(bestIdx + 1);
    let bestF = 0;
    let bestSegD2 = Infinity;
    for (let s = 0; s < 2; s++) {
      const a = s === 0 ? this.wrapIdx(bestIdx - 1) : bestIdx;
      const b = s === 0 ? bestIdx : this.wrapIdx(bestIdx + 1);
      const ax = this.px[a];
      const az = this.pz[a];
      const ex = this.px[b] - ax;
      const ez = this.pz[b] - az;
      const el = ex * ex + ez * ez;
      if (el < 1e-9) continue;
      const f = clamp(((x - ax) * ex + (z - az) * ez) / el, 0, 1);
      const cx = ax + ex * f;
      const cz = az + ez * f;
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 < bestSegD2) {
        bestSegD2 = d2;
        bestF = f;
        segA = a;
        segB = b;
      }
    }

    const ax = this.px[segA];
    const az = this.pz[segA];
    const cx = ax + (this.px[segB] - ax) * bestF;
    const cz = az + (this.pz[segB] - az) * bestF;
    const tanX = lerpN(this.tx[segA], this.tx[segB], bestF);
    const tanZ = lerpN(this.tz[segA], this.tz[segB], bestF);
    const tl = Math.hypot(tanX, tanZ) || 1;
    const nX = -tanZ / tl;
    const nZ = tanX / tl;

    out.lateral = (x - cx) * nX + (z - cz) * nZ;
    out.idx = segA;
    out.dist = ((segA + bestF) / this.count) * this.length;
    out.t = this.closed
      ? ((segA + bestF) / this.count) % 1
      : clamp((segA + bestF) / this.count, 0, 1);
    out.tangentX = tanX / tl;
    out.tangentZ = tanZ / tl;
    out.curvature = lerpN(this.curv[segA], this.curv[segB], bestF);
    return out;
  }

  private gridSearch(x: number, z: number): { idx: number; d2: number } {
    const cs = this.cellSize;
    const gx = Math.floor(x / cs);
    const gz = Math.floor(z / cs);
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let ring = 0; ring <= 6; ring++) {
      let found = false;
      for (let ix = gx - ring; ix <= gx + ring; ix++) {
        for (let iz = gz - ring; iz <= gz + ring; iz++) {
          if (ring > 0 && Math.abs(ix - gx) !== ring && Math.abs(iz - gz) !== ring) continue;
          const bucket = this.cells.get(TrackSampler.cellKey(ix, iz));
          if (!bucket) continue;
          found = true;
          for (let k = 0; k < bucket.length; k++) {
            const i = bucket[k];
            const dx = this.px[i] - x;
            const dz = this.pz[i] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestIdx = i;
            }
          }
        }
      }
      if (found && bestD2 < ring * cs * (ring * cs) + 1) break;
    }
    return { idx: bestIdx < 0 ? 0 : bestIdx, d2: bestD2 };
  }
}

/* -------------------------------------------------------------- lane plan */

export interface LanePlanOptions {
  sampler: TrackSampler;
  clippingZones: readonly ClippingZoneDef[];
  halfWidth: number;
  /** Margin total dari dinding = setengah lebar mobil + safety personality. */
  wallMargin: number;
  /** 0.8 (konservatif) .. 1.06 (garis balap penuh). */
  lineGain: number;
  /** Seberapa agresif bot "memburu" clipping zone. */
  zoneGain: number;
}

/**
 * Garis balap global yang sudah dihaluskan: out-in-out (apex) + buru clipping
 * zone, semuanya dijepit ke koridor aman sehingga bot tidak pernah menempel
 * pembatas. Dibangun sekali, dibaca O(1) per frame.
 */
export class LanePlan {
  readonly offsets: Float32Array;
  readonly limit: number;
  private readonly n: number;
  private readonly closed: boolean;

  constructor(opts: LanePlanOptions) {
    const s = opts.sampler;
    const n = s.count;
    this.n = n;
    this.closed = s.closed;
    this.limit = Math.max(0.5, opts.halfWidth - opts.wallMargin);

    const raw = new Float32Array(n);
    const coordGain = 15.5; // 1/m -> saturasi: R < ~10 m dianggap corner penuh
    const lead = Math.max(6, Math.round(0.03 * n));

    for (let i = 0; i < n; i++) {
      const cNear = s.curvatureAtIdx(i);
      const cLead = s.curvatureAtIdx(i + lead);
      const cBlend = cNear * 0.66 + cLead * 0.34;
      const norm = clamp(cBlend * coordGain, -1, 1);
      // -sign(curv) = sisi dalam tikungan => apex hug ala drift.
      raw[i] = -norm * this.limit * 0.94 * opts.lineGain;
    }

    const bump = new Float32Array(n);
    const zoneStandOff = Math.max(0.4, opts.halfWidth - 1.6);
    for (const cz of opts.clippingZones) {
      const center = Math.round((((cz.t % 1) + 1) % 1) * n);
      const sigma = Math.max(2.5, (cz.radius / Math.max(0.2, s.spacing)) * 0.8);
      const target = clamp(cz.offset * zoneStandOff, -this.limit, this.limit);
      const span = Math.ceil(sigma * 3);
      for (let k = -span; k <= span; k++) {
        const idx = this.wrap(i0Plus(center, k, this.n, this.closed));
        const w = Math.exp(-(k * k) / (2 * sigma * sigma));
        bump[idx] += (target - raw[idx]) * w * 0.92 * opts.zoneGain;
      }
    }
    for (let i = 0; i < n; i++) raw[i] = clamp(raw[i] + bump[i], -this.limit, this.limit);

    // 4 pass smoothing supaya perpindahan lateral tidak pernah "nyentak".
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < n; i++) {
        tmp[i] =
          raw[this.wrap(i - 2)] * 0.12 +
          raw[this.wrap(i - 1)] * 0.24 +
          raw[i] * 0.28 +
          raw[this.wrap(i + 1)] * 0.24 +
          raw[this.wrap(i + 2)] * 0.12;
      }
      for (let i = 0; i < n; i++) raw[i] = clamp(tmp[i], -this.limit, this.limit);
    }
    this.offsets = raw;
  }

  private wrap(i: number): number {
    if (this.closed) return ((i % this.n) + this.n) % this.n;
    return clamp(i, 0, this.n - 1);
  }

  /** Offset lateral (meter) garis balap pada t tertentu. */
  offsetAt(t: number): number {
    const tt = this.closed ? ((t % 1) + 1) % 1 : clamp(t, 0, 1);
    const fi = tt * this.n;
    const i0 = Math.floor(fi) % this.n;
    const i1 = this.closed ? (i0 + 1) % this.n : Math.min(this.n - 1, i0 + 1);
    return lerpN(this.offsets[i0], this.offsets[i1], fi - Math.floor(fi));
  }

  /** Offset garis balap pada jarak index (dipakai build-time saja). */
  offsetAtIdx(i: number): number {
    return this.offsets[this.wrap(i)];
  }
}

const i0Plus = (center: number, k: number, n: number, closed: boolean) =>
  closed ? ((center + k) % n + n) % n : clamp(center + k, 0, n - 1);

/* ------------------------------------------------------------ personality */

export interface BotPersonality {
  seed: number;
  pace: BotPace;
  /** 0.9..1.12 — seberapa berani overspeed masuk corner. */
  aggression: number;
  /** 0.62..1.0 — makin rendah makin halus (jerk kecil). */
  smoothness: number;
  /** 0.8..1.04 — skala garis balap. */
  lineGain: number;
  /** 0.15..0.55 m — wander lambat supaya tiap lap tidak identik. */
  wanderAmp: number;
  /** 0..1 — kecintaan pada feint/manji di trek lurus. */
  feintLove: number;
  /** 0.09..0.20 s — reaksi/look-ahead. */
  reaction: number;
  /** 0.95..1.6 m — margin dinding. */
  wallMargin: number;
  /** 0.86..1.14 — skala sudut drift. */
  driftLove: number;
}

export interface BotPaceConfig {
  base: number;
  aLat: number;
  aAccel: number;
  aBrake: number;
  drift: number;
  margin: number;
  reaction: number;
  lookScale: number;
}

export const BOT_PACE_CONFIG: Record<BotPace, BotPaceConfig> = {
  chill: {
    base: 19.5,
    aLat: 12.5,
    aAccel: 7.6,
    aBrake: 12.5,
    drift: 0.86,
    margin: 1.6,
    reaction: 0.2,
    lookScale: 1.08,
  },
  pro: {
    base: 24.8,
    aLat: 16.2,
    aAccel: 9.8,
    aBrake: 15.5,
    drift: 1.0,
    margin: 1.42,
    reaction: 0.14,
    lookScale: 1.0,
  },
  legend: {
    base: 27.2,
    aLat: 17.9,
    aAccel: 11.2,
    aBrake: 17.5,
    drift: 1.08,
    margin: 1.3,
    reaction: 0.1,
    lookScale: 1.0,
  },
};

export const makePersonality = (seed: number, pace: BotPace): BotPersonality => {
  const r = makeRng(seed * 2654435761 + 12345);
  const cfg = BOT_PACE_CONFIG[pace] ?? BOT_PACE_CONFIG.pro;
  const pick = (lo: number, hi: number) => lo + r() * (hi - lo);
  return {
    seed,
    pace,
    aggression: pick(0.9, 1.12),
    smoothness: pick(0.62, 1.0),
    lineGain: pick(0.82, 1.04),
    wanderAmp: pick(0.12, 0.48),
    feintLove: pick(0.05, 1.0) * pick(0.05, 1.0),
    reaction: cfg.reaction * pick(0.85, 1.2),
    wallMargin: pick(cfg.margin * 0.96, cfg.margin * 1.12),
    driftLove: pick(0.86, 1.14),
  };
};

/* ---------------------------------------------------------------- contact */

export interface ContactBody {
  x: number;
  z: number;
  heading: number;
  velAngle: number;
  speed: number;
  yawRate: number;
}

export interface ContactOptions {
  sphereOffset?: number;
  sphereRadius?: number;
  restitution?: number;
  friction?: number;
  /** Kecepatan maksimum koreksi posisi (m/s) supaya tidak teleport. */
  separationSpeed?: number;
  maxImpulse?: number;
  torqueScale?: number;
  maxTorque?: number;
  maxSpeed?: number;
}

export interface ContactResult {
  hit: boolean;
  kind: 'rub' | 'bump' | 'clash';
  normalX: number;
  normalZ: number;
  pointX: number;
  pointZ: number;
  penetration: number;
  impulse: number;
  approach: number;
  offsetA: number;
  offsetB: number;
  sideHit: boolean;
  spinA: number;
  spinB: number;
}

export const makeContactResult = (): ContactResult => ({
  hit: false,
  kind: 'rub',
  normalX: 1,
  normalZ: 0,
  pointX: 0,
  pointZ: 0,
  penetration: 0,
  impulse: 0,
  approach: 0,
  offsetA: 0,
  offsetB: 0,
  sideHit: false,
  spinA: 0,
  spinB: 0,
});

const bodyVelX = (b: ContactBody) => Math.sin(b.velAngle) * b.speed;
const bodyVelZ = (b: ContactBody) => Math.cos(b.velAngle) * b.speed;

/**
 * Terapkan impuls ke body (kecepatan skalar + arah travel). Tidak pernah
 * membalik arah mobil mendadak: kalau impuls akan memundurkan mobil,
 * kecepatan cukup diredupkan ke minimum (mobil berhenti lalu memisah).
 */
const applyImpulse = (b: ContactBody, ix: number, iz: number, maxSpeed: number) => {
  const nx = bodyVelX(b) + ix;
  const nz = bodyVelZ(b) + iz;
  const dirX = Math.sin(b.velAngle);
  const dirZ = Math.cos(b.velAngle);
  if (nx * dirX + nz * dirZ <= 0.05) {
    b.speed = 0.55;
    return;
  }
  const sp = Math.hypot(nx, nz);
  const capped = Math.min(sp, maxSpeed);
  b.speed = capped;
  b.velAngle = Math.atan2(nx, nz);
};

/**
 * Solver tabrakan dua mobil RC (3 sphere per mobil: bumper depan, chassis,
 * bumper belakang). Sifatnya: separasi dibatasi kecepatan, impuls proporsional
 * kecepatan mendekat, friksi tangensial, spin terbatas => kontak terasa
 * "senggol" halus tapi tetap bisa mendorong/menyerempet lawan.
 */
export const resolveRcContact = (
  a: ContactBody,
  b: ContactBody,
  dt: number,
  opts: ContactOptions = {},
  out: ContactResult = makeContactResult()
): ContactResult => {
  const off = opts.sphereOffset ?? 1.05;
  const rad = opts.sphereRadius ?? 0.92;
  const restitution = opts.restitution ?? 0.32;
  const friction = opts.friction ?? 0.42;
  const separationSpeed = opts.separationSpeed ?? 1.6;
  const maxImpulse = opts.maxImpulse ?? 5.6;
  const torqueScale = opts.torqueScale ?? 0.16;
  const maxTorque = opts.maxTorque ?? 1.0;
  const maxSpeed = opts.maxSpeed ?? 30;

  out.hit = false;
  out.impulse = 0;
  out.penetration = 0;
  out.approach = 0;
  out.spinA = 0;
  out.spinB = 0;
  out.sideHit = false;

  const ax = Math.sin(a.heading);
  const az = Math.cos(a.heading);
  const bx = Math.sin(b.heading);
  const bz = Math.cos(b.heading);

  let penSum = 0;
  let penMax = 0;
  let accNx = 0;
  let accNz = 0;
  let accPx = 0;
  let accPz = 0;
  let offsetA = 0;
  let offsetB = 0;

  for (let i = -1; i <= 1; i++) {
    const oa = i * off;
    const cax = a.x + ax * oa;
    const caz = a.z + az * oa;
    for (let j = -1; j <= 1; j++) {
      const ob = j * off;
      const cbx = b.x + bx * ob;
      const cbz = b.z + bz * ob;
      const dx = cax - cbx;
      const dz = caz - cbz;
      const d = Math.hypot(dx, dz);
      const minSep = rad * 2;
      if (d >= minSep) continue;
      const pen = minSep - d;
      const nX = d > 1e-4 ? dx / d : ax;
      const nZ = d > 1e-4 ? dz / d : az;
      penSum += pen;
      accNx += nX * pen;
      accNz += nZ * pen;
      accPx += (cax + cbx) * 0.5 * pen;
      accPz += (caz + cbz) * 0.5 * pen;
      if (pen >= penMax) {
        penMax = pen;
        offsetA = oa;
        offsetB = ob;
      }
    }
  }

  if (penSum <= 1e-5) return out;

  let nX = accNx;
  let nZ = accNz;
  const nl = Math.hypot(nX, nZ);
  if (nl < 1e-5) {
    nX = ax;
    nZ = az;
  } else {
    nX /= nl;
    nZ /= nl;
  }

  const penetration = Math.min(penSum, 1.6);
  out.hit = true;
  out.normalX = nX;
  out.normalZ = nZ;
  out.pointX = accPx / penSum;
  out.pointZ = accPz / penSum;
  out.penetration = penetration;
  out.offsetA = offsetA;
  out.offsetB = offsetB;
  out.sideHit = Math.abs(ax * nX + az * nZ) < 0.62;

  /* 1. Separasi posisi berkecepatan terbatas (tidak teleport) */
  const corr = Math.min(penetration * 0.5, separationSpeed * dt);
  a.x += nX * corr * 0.5;
  a.z += nZ * corr * 0.5;
  b.x -= nX * corr * 0.5;
  b.z -= nZ * corr * 0.5;

  /* 2. Impuls normal murni dari kecepatan mendekat */
  const rvx = bodyVelX(a) - bodyVelX(b);
  const rvz = bodyVelZ(a) - bodyVelZ(b);
  const vn = rvx * nX + rvz * nZ;
  out.approach = vn;

  if (vn < 0) {
    const j = Math.min(maxImpulse, Math.max(0, -(1 + restitution) * vn * 0.5));
    out.impulse = j;
    if (j > 0.001) {
      applyImpulse(a, nX * j, nZ * j, maxSpeed);
      applyImpulse(b, -nX * j, -nZ * j, maxSpeed);

      /* 3. Friksi tangensial => "nyeret"/slide, bukan mantul */
      const tX = -nZ;
      const tZ = nX;
      const vt = bodyVelX(a) * tX + bodyVelZ(a) * tZ - (bodyVelX(b) * tX + bodyVelZ(b) * tZ);
      const jt = clamp(-vt * 0.5, -friction * j, friction * j);
      if (Math.abs(jt) > 0.001) {
        applyImpulse(a, tX * jt, tZ * jt, maxSpeed);
        applyImpulse(b, -tX * jt, -tZ * jt, maxSpeed);
      }

      /* 4. Spin (PIT maneuver) terbatas & berskala fisik */
      const spinA = clamp(
        torqueScale * offsetA * j * (az * nX - ax * nZ),
        -maxTorque,
        maxTorque
      );
      const spinB = clamp(
        -torqueScale * offsetB * j * (bz * nX - bx * nZ),
        -maxTorque,
        maxTorque
      );
      a.yawRate += spinA;
      b.yawRate += spinB;
      out.spinA = spinA;
      out.spinB = spinB;
    }
  }

  out.kind = out.impulse < 2.0 ? 'rub' : out.impulse < 4.6 ? 'bump' : 'clash';
  return out;
};

/* ------------------------------------------------------------- the driver */

export type BotMode = 'start' | 'line' | 'recover' | 'unstick';

export interface BotInput {
  dt: number;
  time: number;
  raceStarted: boolean;
  halfWidth: number;
  /** Setengah lebar mobil + sedikit toleransi (dipakai untuk backstop dinding). */
  carMargin: number;
  aLatScale: number;
  speedFactor: number;
  sampler: TrackSampler;
  lane: LanePlan;
  playerVisible: boolean;
  playerT: number;
  playerSpeed: number;
  playerLateral: number;
  playerHeading: number;
}

const MAX_SLIP_RAD = 1.16; // ~66° sudut drift pro

export class ProDriftBot {
  // --- pose & dynamics ---
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  velAngle = 0;
  speed = 0;
  yawRate = 0;
  slip = 0;
  slipRate = 0;
  steerAngle = 0;
  accel = 0;

  // --- info publik untuk HUD / visual / efek ---
  t = 0;
  lateral = 0;
  curvature = 0;
  mode: BotMode = 'start';
  targetSpeed = 0;
  throttle = 0;
  brake = 0;
  wallPressure = 0;
  contactPulse = 0;
  lapCount = 0;
  lineScale = 1;
  paceScale = 1;

  readonly personality: BotPersonality;
  readonly paceCfg: BotPaceConfig;
  readonly corridor: number;
  readonly hardLimit: number;

  private readonly proj = makeTrackProjection();
  private readonly pose = makeTrackPose();
  private readonly rng: () => number;
  private readonly moodNoise: SmoothNoise;
  private readonly wanderNoise: SmoothNoise;
  private readonly feintNoise: SmoothNoise;

  private projHint = -1;
  private modeTimer = 0;
  private stuckTimer = 0;
  private offLineTimer = 0;
  private launchTimer = 1;
  private raceWasStarted = false;
  private feintTimer = 0;
  private feintCooldown = 3;
  private feintDir = 1;
  private contactRecover = 0;
  private lastT = 0;
  private wallBias = 0;
  private recoverSide = 0;
  private unstickPhase = 0;
  private moodTimer = 0;
  private gapSmooth = 0;
  private gapValid = false;

  constructor(opts: {
    personality: BotPersonality;
    x: number;
    z: number;
    heading: number;
    t: number;
    halfWidth: number;
    carMargin: number;
    lineScale?: number;
  }) {
    this.personality = opts.personality;
    this.paceCfg = BOT_PACE_CONFIG[opts.personality.pace] ?? BOT_PACE_CONFIG.pro;
    this.x = opts.x;
    this.z = opts.z;
    this.heading = opts.heading;
    this.velAngle = opts.heading;
    this.t = opts.t;
    this.lastT = opts.t;
    this.lineScale = opts.lineScale ?? 1;
    this.corridor = Math.max(
      0.55,
      opts.halfWidth - opts.carMargin - this.personality.wallMargin
    );
    // Backstop fisik: hanya untuk kejadian ekstrem, bukan untuk dipakai harian.
    this.hardLimit = Math.min(opts.halfWidth - opts.carMargin - 0.12, this.corridor + 0.75);
    this.rng = makeRng(opts.personality.seed * 977 + 13);
    this.moodNoise = new SmoothNoise(opts.personality.seed * 7 + 3);
    this.wanderNoise = new SmoothNoise(opts.personality.seed * 13 + 11);
    this.feintNoise = new SmoothNoise(opts.personality.seed * 29 + 5);
  }

  get driftDeg(): number {
    return Math.abs(this.slip) * (180 / Math.PI);
  }

  /**
   * Dipanggil komponen saat mobil pemain menyentuh bot.
   * `spin` (rad/s) adalah tendangan rotasi dari solver kontak: dimasukkan ke
   * slipRate supaya body ikut terpelintir lalu pulih sendiri (spring-damper),
   * bukan di-set langsung ke heading (yang bikin gerakan patah).
   */
  notifyContact(kind: 'rub' | 'bump' | 'clash', fromBehind: boolean, spin = 0) {
    this.contactPulse = 1;
    const spinKick = clamp(spin * 2.2, -2.4, 2.4);
    if (kind === 'rub' && fromBehind) {
      // senggolan tandem: bot tetap tenang, cukup stabilkan sedikit.
      this.contactRecover = Math.max(this.contactRecover, 0.26);
      this.slipRate = this.slipRate * 0.7 + spinKick * 0.5;
      return;
    }
    if (kind === 'bump') {
      this.contactRecover = Math.max(this.contactRecover, 0.5);
      this.slipRate = this.slipRate * 0.55 + spinKick * 0.8;
      return;
    }
    this.contactRecover = Math.max(this.contactRecover, 0.95);
    this.yawRate *= 0.55;
    this.slipRate = this.slipRate * 0.4 + spinKick;
    this.speed *= 0.93;
  }

  private setMode(mode: BotMode, duration: number) {
    if (this.mode !== mode) {
      this.mode = mode;
      this.modeTimer = duration;
    } else {
      this.modeTimer = Math.max(this.modeTimer, duration);
    }
  }

  step(inp: BotInput) {
    const dt = Math.min(0.05, Math.max(1 / 240, inp.dt));
    // Substepping: fisika tetap stabil & halus walau frame drop (20/30 fps).
    const steps = dt > 0.024 ? 4 : dt > 0.014 ? 2 : 1;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) this.substep(inp, h, inp.time + s * h);
    this.contactPulse = Math.max(0, this.contactPulse - dt * 3.2);
  }

  private substep(inp: BotInput, h: number, time: number) {
    const sampler = inp.sampler;
    const lane = inp.lane;
    const pace = this.paceCfg;

    if (inp.raceStarted && !this.raceWasStarted) {
      this.raceWasStarted = true;
      this.launchTimer = 0;
    }

    /* --- 0. PROYEKSI KE SPLINE -------------------------------------- */
    sampler.project(this.x, this.z, this.proj, this.projHint);
    this.projHint = this.proj.idx;
    const t = this.proj.t;
    const lateral = this.proj.lateral;
    const nX = -this.proj.tangentZ;
    const nZ = this.proj.tangentX;
    this.t = t;
    this.lateral = lateral;
    this.curvature = this.proj.curvature;
    const length = sampler.length;
    const spd = Math.abs(this.speed);
    const velX = Math.sin(this.velAngle) * this.speed;
    const velZ = Math.cos(this.velAngle) * this.speed;
    const latVel = velX * nX + velZ * nZ;

    if (this.lastT > 0.85 && t < 0.15 && spd > 2) this.onLapCross();
    this.lastT = t;

    /* --- 1. MOOD & WANDER (variasi, bukan random per frame) --------- */
    this.moodTimer += h;
    this.paceScale = damp(this.paceScale, 1 + this.moodNoise.at(this.moodTimer * 0.09 + 17) * 0.055, 1.2, h);
    const wander =
      this.wanderNoise.at(time * 0.055 + this.lapCount * 3.3) * this.personality.wanderAmp;

    /* --- 2. KORIDOR & TEKANAN DINDING (prediktif, tanpa clamp kasar) - */
    const speedMargin = Math.min(0.5, spd * 0.02);
    const corridor = Math.max(0.55, this.corridor - speedMargin);
    const predictedLat = lateral + latVel * 0.42;
    let wallPressure = 0;
    const predOver = Math.abs(predictedLat) - corridor * 0.88;
    if (predOver > 0 && Math.sign(predictedLat) === Math.sign(lateral || predictedLat)) {
      wallPressure = clamp(predOver / 0.85, 0, 1);
      this.wallBias = moveTowards(
        this.wallBias,
        -Math.sign(predictedLat) * predOver * 1.15,
        3.2 * h
      );
    } else {
      this.wallBias = damp(this.wallBias, 0, 2.0, h);
    }
    if (Math.abs(lateral) > corridor) {
      const excess = Math.abs(lateral) - corridor;
      wallPressure = Math.max(wallPressure, clamp(excess / 0.5, 0, 1));
      this.wallBias = moveTowards(this.wallBias, -Math.sign(lateral) * excess * 1.1, 4.0 * h);
    }
    this.wallPressure = damp(this.wallPressure, wallPressure, 6.0, h);

    /* --- 3. STATE MACHINE ------------------------------------------- */
    const outOfCorridor = Math.abs(lateral) > corridor + 0.5;
    const offTrack = Math.abs(lateral) > inp.halfWidth - 1.15;
    this.offLineTimer = outOfCorridor
      ? this.offLineTimer + h
      : Math.max(0, this.offLineTimer - h * 2);
    this.stuckTimer = spd < 1.1 && inp.raceStarted ? this.stuckTimer + h : 0;
    this.contactRecover = Math.max(0, this.contactRecover - h);
    this.feintCooldown = Math.max(0, this.feintCooldown - h);
    this.launchTimer += h;

    if (!inp.raceStarted) {
      this.setMode('start', 0.2);
      this.unstickPhase = 0;
      this.stuckTimer = 0;
    } else if (this.mode === 'unstick') {
      this.modeTimer -= h;
      this.unstickPhase += h;
      if (this.modeTimer <= 0) this.setMode('recover', 0.85);
    } else if (this.stuckTimer > 1.4) {
      // benar-benar macet -> mundur halus lalu rejoin.
      this.setMode('unstick', 1.45);
      this.unstickPhase = 0;
      this.stuckTimer = 0;
    } else if (this.contactRecover > 0) {
      this.setMode('recover', this.contactRecover);
    } else if (this.offLineTimer > 0.16 || offTrack) {
      const side = Math.sign(lateral) || 1;
      this.recoverSide = Math.sign(inp.playerLateral) === side ? -side : side;
      this.setMode('recover', offTrack ? 1.1 : 0.7);
    } else if (this.mode === 'recover' || this.mode === 'start') {
      if (this.modeTimer <= 0) this.setMode('line', 0);
      else this.modeTimer -= h;
    } else {
      this.modeTimer = Math.max(0, this.modeTimer - h);
    }

    const recovering = this.mode === 'recover';
    const unsticking = this.mode === 'unstick';

    /* --- 4. FEINT / MANJI (bikin garis tidak monoton) --------------- */
    if (
      !recovering &&
      !unsticking &&
      inp.raceStarted &&
      this.feintCooldown <= 0 &&
      this.feintTimer <= 0 &&
      spd > 11 &&
      Math.abs(this.curvature) < 0.013 &&
      this.feintNoise.at(time * 0.4) > 0.2 &&
      this.rng() < this.personality.feintLove * 0.03
    ) {
      this.feintTimer = 0.42 + this.personality.feintLove * 0.22;
      this.feintDir = this.feintNoise.at(time * 1.7) > 0 ? 1 : -1;
      this.feintCooldown = 3.4 + this.rng() * 3.4;
    }
    let feintSlip = 0;
    let feintLane = 0;
    if (this.feintTimer > 0) {
      this.feintTimer -= h;
      const p = 1 - clamp(this.feintTimer / 0.5, 0, 1);
      const env = Math.sin(Math.PI * clamp(p, 0, 1));
      feintSlip = this.feintDir * env * 0.3;
      feintLane = this.feintDir * env * 0.2;
    }

    /* --- 5. TARGET GARIS & LOOK-AHEAD ------------------------------- */
    const laneHere = lane.offsetAt(t) * this.lineScale;
    const latErrNow = lateral - (laneHere + wander + this.wallBias);
    // Look-ahead paralel: makin cepat makin jauh, tapi dijepit supaya tidak
    // jadi "malas" di kecepatan 2x.
    const lookBase =
      clamp(3.4 + spd * 0.4, 3.4, 18) * pace.lookScale * (1 + this.personality.reaction * 0.5);
    // Jauh dari garis -> lihat lebih jauh supaya sudut masuk landai (rejoin mulus).
    const look = recovering
      ? Math.max(lookBase * 1.25, 6.5 + Math.abs(latErrNow) * 2.6)
      : unsticking
      ? lookBase * 0.6
      : lookBase;
    const tAhead = this.closedT(t + look / length, sampler.closed);
    const poseAhead = sampler.poseAtT(tAhead, this.pose);

    // Feed-forward kelengkungan (dipakai untuk target garis & kendali yaw).
    const cMid = sampler.curvatureAtT(tAhead);
    const cFar = sampler.curvatureAtT(this.closedT(t + (look * 1.9) / length, sampler.closed));
    const curvFf = cMid * 0.6 + cFar * 0.4;
    const curvFfHint = this.proj.curvature * 0.4 + curvFf * 0.6;

    let targetLaneAhead = lane.offsetAt(tAhead) * this.lineScale + wander + feintLane;
    // Kompensasi pelebaran drift: saat mobil meluncur (slip besar) garis
    // travel-nya melebar keluar, jadi titik bidik digeser sedikit ke dalam.
    targetLaneAhead -= Math.sign(curvFfHint) * Math.min(0.55, Math.abs(this.slip) * 0.3) * (corridor / 2.6);
    targetLaneAhead += this.wallBias;
    if (recovering) {
      // Rejoin dari sisi aman: hindari memotong depan mobil pemain.
      const safe = this.recoverSide * corridor * 0.3;
      targetLaneAhead = lerpN(clamp(targetLaneAhead, -this.corridor, this.corridor), safe, 0.3);
    }
    targetLaneAhead = clamp(targetLaneAhead, -this.corridor, this.corridor);

    /* --- 6. KENDALI JALUR: feed-forward kelengkungan + pursuit PD --- */
    const tgtX = poseAhead.x + poseAhead.nx * targetLaneAhead;
    const tgtZ = poseAhead.z + poseAhead.nz * targetLaneAhead;
    const desiredHeading = Math.atan2(tgtX - this.x, tgtZ - this.z);
    const headingErr = wrapPi(desiredHeading - this.velAngle);

    const smoothFactor = clamp(this.personality.smoothness, 0, 1);
    let velYawRateTarget =
      curvFf * this.speed * 0.92 +
      headingErr * (2.35 - 0.95 * smoothFactor) -
      latVel * 0.06;

    if (!inp.raceStarted) velYawRateTarget *= 0.15;
    if (recovering) velYawRateTarget *= 0.7;
    if (unsticking) velYawRateTarget *= 0.3;

    // Grip sudut ikut naik sedikit saat speed level dinaikkan, supaya bot tetap
    // kompetitif di mode SEDANG/2X tanpa jadi tidak masuk akal.
    const aLatMax =
      pace.aLat *
      inp.aLatScale *
      clamp(inp.speedFactor, 1, 1.35) *
      (recovering ? 0.72 : 1);
    const maxYawRate = Math.min((aLatMax * 0.9) / Math.max(spd, 2.2), 2.9);
    velYawRateTarget = clamp(velYawRateTarget, -maxYawRate, maxYawRate);

    const yawAccelMax =
      clamp(26 / Math.max(spd, 3.5), 1.2, 8.0) * (0.72 + 0.28 * (1 - smoothFactor));
    const yawAccel = clamp((velYawRateTarget - this.yawRate) * 7.2, -yawAccelMax, yawAccelMax);
    this.yawRate += yawAccel * h;
    this.velAngle = wrapPi(this.velAngle + this.yawRate * h);

    /* --- 7. SUDUT DRIFT (slip) ORDE-2 ------------------------------- */
    const cornerLoad = clamp(
      (Math.abs(velYawRateTarget) * Math.max(spd, 3)) / Math.max(1, aLatMax),
      0,
      1.25
    );
    const cornerDir = Math.sign(velYawRateTarget) || Math.sign(curvFf) || 1;
    let slipTarget =
      cornerDir *
      MAX_SLIP_RAD *
      (0.28 + 0.72 * Math.sqrt(clamp(cornerLoad, 0, 1))) *
      pace.drift *
      this.personality.driftLove *
      clamp(spd / 9, 0.1, 1);
    slipTarget *= 1 + clamp(this.throttle - 0.5, -0.2, 0.3) * 0.18;
    if (recovering || !inp.raceStarted) slipTarget *= 0.34;
    if (unsticking) slipTarget *= 0.12;
    if (this.launchTimer < 0.85 && inp.raceStarted) slipTarget += 0.3;
    if (this.wallPressure > 0.35) slipTarget *= 1 - this.wallPressure * 0.2;
    slipTarget += feintSlip;
    slipTarget = clamp(slipTarget, -MAX_SLIP_RAD, MAX_SLIP_RAD);

    // Spring-damper orde-2 (omega ~ 4.5 rad/s, zeta ~ 0.9) => transisi manji luwes.
    const slipAccel = clamp((slipTarget - this.slip) * 20.5 - this.slipRate * 8.4, -26, 26);
    this.slipRate += slipAccel * h;
    const headingRateLimit = 4.6;
    this.slipRate = clamp(this.slipRate, -headingRateLimit, headingRateLimit);
    this.slip = clamp(this.slip + this.slipRate * h, -1.35, 1.35);
    this.heading = wrapPi(this.velAngle + this.slip);

    /* --- 8. KECEPATAN: braking distance + jerk limit ---------------- */
    const brakingDist = (spd * spd) / (2 * Math.max(4, pace.aBrake)) + 3.2;
    let vLimit = Infinity;
    const aheadSamples = 7;
    for (let k = 0; k < aheadSamples; k++) {
      const d = (k / (aheadSamples - 1)) * (brakingDist + 5);
      const c = Math.abs(sampler.curvatureAtDist(this.proj.dist + d));
      vLimit = Math.min(vLimit, Math.sqrt((aLatMax * 0.86) / Math.max(c, 1e-4)));
    }
    vLimit = Math.min(vLimit, Math.sqrt((aLatMax * 0.86) / Math.max(Math.abs(cFar), 1e-3)));

    let targetSpeed = Math.min(
      pace.base * inp.speedFactor * this.paceScale,
      vLimit * this.personality.aggression
    );
    if (recovering) {
      targetSpeed = Math.min(targetSpeed, pace.base * inp.speedFactor * (offTrack ? 0.55 : 0.74));
    }
    if (unsticking || !inp.raceStarted) targetSpeed = 0;

    if (inp.playerVisible && inp.raceStarted) {
      // Gap longitudinal dihaluskan: proyeksi t pemain dari komponen
      // terkuantisasi 1/120, tanpa filter bisa memicu on/off gas.
      const rawGap = this.longitudinalGap(inp, t, length);
      if (!this.gapValid) {
        this.gapSmooth = rawGap;
        this.gapValid = true;
      } else {
        this.gapSmooth = damp(this.gapSmooth, rawGap, 4.5, h);
      }
      const gap = this.gapSmooth;
      const closing = spd - inp.playerSpeed;
      if (gap > 0 && gap < 10) {
        // Menempel pro: jangan sengaja menghajar, tapi tetap dekat.
        targetSpeed = Math.min(targetSpeed, Math.max(4.5, inp.playerSpeed + clamp(closing - 0.8, 0, 6)));
        if (gap < 2.8 && closing > 1.2) targetSpeed = Math.min(targetSpeed, inp.playerSpeed * 0.98);
      } else if (gap <= 0 && gap > -6 && inp.playerVisible) {
        // Pemain menempel di belakang -> sedikit tutup garis (defensif, halus).
        targetLaneAhead += Math.sign(inp.playerLateral || 1) * 0.22;
      }
    }

    const traction = 1 - 0.34 * clamp(Math.abs(this.slip) / 1.15, 0, 1);
    const accelCmd = clamp(
      (targetSpeed - spd) * 2.7,
      -pace.aBrake * (recovering ? 0.8 : 1),
      pace.aAccel * traction
    );
    this.accel = damp(this.accel, accelCmd, 6.5, h);
    this.targetSpeed = targetSpeed;
    this.throttle = clamp(this.accel / Math.max(1, pace.aAccel), 0, 1);
    this.brake = clamp(-this.accel / Math.max(1, pace.aBrake), 0, 1);

    if (unsticking) {
      const target = this.unstickPhase < 0.85 ? -2.2 : 2.0;
      this.speed = damp(this.speed, target, 2.6, h);
      this.velAngle = wrapPi(this.velAngle - Math.sign(lateral || 1) * 0.9 * h);
      this.slip = damp(this.slip, 0, 4.5, h);
      this.heading = wrapPi(this.velAngle + this.slip);
    } else {
      this.speed = clamp(this.speed + this.accel * h, 0, 32);
    }

    /* --- 9. INTEGRASI POSISI --------------------------------------- */
    const nvx = Math.sin(this.velAngle) * this.speed;
    const nvz = Math.cos(this.velAngle) * this.speed;
    this.x += nvx * h;
    this.z += nvz * h;

    /* --- 10. DINDING: cushion lembut, bukan clamp mendadak --------- */
    // lateral setelah bergerak 1 sub-step (proyeksi diperbarui tiap sub-step).
    const latNow = lateral + (nvx * nX + nvz * nZ) * h;
    if (Math.abs(latNow) > corridor) {
      const excess = Math.abs(latNow) - corridor;
      const sgn = Math.sign(latNow) || 1;
      const push = Math.min(excess, 3.0 * h);
      this.x -= sgn * nX * push;
      this.z -= sgn * nZ * push;
      const outLat = nvx * nX + nvz * nZ;
      if (outLat * sgn > 0) {
        const kill = Math.min(outLat * sgn, 16 * h);
        const tanV = nvx * this.proj.tangentX + nvz * this.proj.tangentZ;
        const newLat = outLat - sgn * kill;
        const rx = this.proj.tangentX * tanV + nX * newLat;
        const rz = this.proj.tangentZ * tanV + nZ * newLat;
        this.speed = Math.hypot(rx, rz);
        this.velAngle = Math.atan2(rx, rz);
      }
      // gesek dinding: kecepatan disapu perlahan, tanpa hentakan.
      this.speed *= Math.max(0.2, 1 - clamp(excess, 0, 1) * 0.55 * h);
    }
    if (Math.abs(latNow) > this.hardLimit) {
      const sgn = Math.sign(latNow) || 1;
      const fix = Math.abs(latNow) - this.hardLimit;
      this.x -= sgn * nX * fix;
      this.z -= sgn * nZ * fix;
      this.speed *= 0.94;
    }

    /* --- 11. VISUAL: counter-steer rate-limited (servo halus) ------ */
    const steerTarget = clamp(-this.slip * 0.95 - headingErr * 0.2, -1.32, 1.32);
    this.steerAngle = moveTowards(this.steerAngle, steerTarget, 9.5 * h);
  }

  private onLapCross() {
    this.lapCount++;
    // Variasi garis antar lap: bot tidak melukis garis yang sama dua kali.
    this.lineScale = clamp(1 + this.wanderNoise.at(this.lapCount * 2.7 + 40) * 0.07, 0.9, 1.08);
  }

  private closedT(t: number, closed: boolean): number {
    if (closed) return ((t % 1) + 1) % 1;
    return clamp(t, 0, 1);
  }

  /** Jarak longitudinal (m) ke mobil pemain; positif = pemain di depan bot. */
  private longitudinalGap(inp: BotInput, myT: number, length: number): number {
    let d = inp.playerT - myT;
    if (inp.sampler.closed) {
      if (d < -0.5) d += 1;
      if (d > 0.5) d -= 1;
    }
    return d * length;
  }
}
