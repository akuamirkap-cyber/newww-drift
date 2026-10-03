/**
 * Offline harness untuk PRO DRIFT BOT v2 (Sakura RC).
 *
 * Menguji keluhan utama:
 *   - halus / tidak kaku      -> max lateral accel, max jerk, max steer rate
 *   - menurut jalur           -> max |lateral|, jumlah frame keluar koridor
 *   - tidak mepet pembatas    -> tidak boleh menyentuh hardLimit dinding
 *   - keluar jalur -> rejoin  -> skenario teleport + heading salah
 *   - tabrakan tetap bisa     -> solver kontak (impuls, spin, separasi)
 *   - tidak gampang ditebak   -> dua seed menghasilkan garis berbeda
 *
 * Jalankan:      npx tsx scripts/sakura_probot_test.mts
 * Tanpa tsx:     npx esbuild scripts/sakura_probot_test.mts --bundle --platform=node \
 *                  --format=esm --outfile=/tmp/sakura_test.mjs && node /tmp/sakura_test.mjs
 */
import * as THREE from 'three';
import {
  LanePlan,
  ProDriftBot,
  TrackSampler,
  makePersonality,
  makeContactResult,
  resolveRcContact,
  type BotInput,
  type ContactBody,
} from '../src/games/sakura_rc/game/proBot.ts';
import type { BotPace, ClippingZoneDef } from '../src/games/sakura_rc/types/rcDrift.ts';

const HALF_WIDTH = 5.2;
const CAR_MARGIN = 0.95;

/* ------------------------------------------------------------ test track */
const buildTrack = () => {
  const pts: [number, number][] = [
    [0, 0], [42, -2], [76, 4], [98, 20], [102, 44], [86, 62], [60, 66], [44, 52],
    [36, 34], [24, 24], [4, 26], [-14, 38], [-34, 44], [-48, 32], [-50, 12], [-34, -2],
  ];
  const v = pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  return new THREE.CatmullRomCurve3(v, true, 'centripetal', 0.5);
};

const zones: ClippingZoneDef[] = [
  { id: 'z1', label: 'OZ BRAKE', type: 'outer_zone', t: 0.22, offset: 0.66, radius: 4.8, minAngle: 25, basePoints: 500 },
  { id: 'z2', label: 'IZ APEX', type: 'inner_clip', t: 0.38, offset: -0.62, radius: 3.6, minAngle: 30, basePoints: 700 },
  { id: 'z3', label: 'WALL KISS', type: 'wall_kiss', t: 0.66, offset: 0.72, radius: 4.4, minAngle: 28, basePoints: 650 },
  { id: 'z4', label: 'IZ FINAL', type: 'inner_clip', t: 0.86, offset: -0.58, radius: 3.4, minAngle: 26, basePoints: 600 },
];

const sampler = new TrackSampler(buildTrack(), { closed: true, samples: 900 });

interface RunStats {
  laps: number;
  time: number;
  maxLat: number;
  meanLat: number;
  maxLatAccel: number;
  maxJerk: number;
  lineJerk: number;
  yawJerk: number;
  chatterPerSec: number;
  maxSteerRate: number;
  offCorridorFrames: number;
  hardLimitHits: number;
  offTrackFrames: number;
  maxYawAccel: number;
  avgSpeed: number;
  slipMaxDeg: number;
  modes: Record<string, number>;
  snaps: number;
}

const runLaps = (
  pace: BotPace,
  seed: number,
  dt: number,
  laps: number,
  disturb?: (bot: ProDriftBot, time: number) => void
): RunStats => {
  const personality = makePersonality(seed, pace);
  const lane = new LanePlan({
    sampler,
    clippingZones: zones,
    halfWidth: HALF_WIDTH,
    wallMargin: CAR_MARGIN + personality.wallMargin,
    lineGain: personality.lineGain,
    zoneGain: 0.9,
  });
  const start = sampler.poseAtT(0.01, {
    x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: -1, nz: 0, curvature: 0, t: 0, dist: 0,
  });
  const bot = new ProDriftBot({
    personality,
    x: start.x + start.nx * 1.4,
    z: start.z + start.nz * 1.4,
    heading: Math.atan2(start.tx, start.tz),
    t: start.t,
    halfWidth: HALF_WIDTH,
    carMargin: CAR_MARGIN,
  });

  const input: BotInput = {
    dt,
    time: 0,
    raceStarted: false,
    halfWidth: HALF_WIDTH,
    carMargin: CAR_MARGIN,
    aLatScale: 1,
    speedFactor: 1,
    sampler,
    lane,
    playerVisible: false,
    playerT: 0,
    playerSpeed: 0,
    playerLateral: 0,
    playerHeading: 0,
  };

  const stats: RunStats = {
    laps: 0,
    time: 0,
    maxLat: 0,
    meanLat: 0,
    maxLatAccel: 0,
    maxJerk: 0,
    lineJerk: 0,
    yawJerk: 0,
    chatterPerSec: 0,
    maxSteerRate: 0,
    offCorridorFrames: 0,
    hardLimitHits: 0,
    offTrackFrames: 0,
    maxYawAccel: 0,
    avgSpeed: 0,
    slipMaxDeg: 0,
    modes: {},
    snaps: 0,
  };

  let time = 0;
  let latSum = 0;
  let frames = 0;
  let lapsDone = 0;
  let lastYawRate = 0;
  let lastSteer = 0;
  let prevSlipRate = 0;
  let flips = 0;
  let lastLatVel = 0;
  let prevT = start.t;
  const maxTime = 300;

  while (lapsDone < laps && time < maxTime) {
    input.dt = dt;
    input.time = time;
    input.raceStarted = time > 1.0;
    bot.step(input);
    if (disturb) disturb(bot, time);

    const latVel = Math.abs(bot.speed * Math.sin(bot.slip));
    const yawAccel = Math.abs(bot.yawRate - lastYawRate) / dt;
    const steerRate = Math.abs(bot.steerAngle - lastSteer) / dt;
    const jerk = Math.abs(latVel - lastLatVel) / dt;
    const latAccel = bot.speed * Math.abs(bot.yawRate);

    if (!Number.isFinite(bot.x + bot.z + bot.heading + bot.speed)) {
      check('finite state', false, `NaN/Inf di t=${time.toFixed(2)}`);
      return stats;
    }
    stats.maxLat = Math.max(stats.maxLat, Math.abs(bot.lateral));
    stats.maxLatAccel = Math.max(stats.maxLatAccel, latAccel);
    stats.maxJerk = Math.max(stats.maxJerk, jerk);
    if (bot.mode === 'line' && time > 2) stats.lineJerk = Math.max(stats.lineJerk, jerk);
    stats.maxSteerRate = Math.max(stats.maxSteerRate, steerRate);
    stats.maxYawAccel = Math.max(stats.maxYawAccel, yawAccel);
    stats.yawJerk = Math.max(stats.yawJerk, Math.abs(bot.slipRate - prevSlipRate) / dt);
    if (Math.abs(bot.slipRate) > 0.05 && Math.abs(prevSlipRate) > 0.05) {
      if (Math.sign(bot.slipRate) !== Math.sign(prevSlipRate)) flips++;
    }
    stats.slipMaxDeg = Math.max(stats.slipMaxDeg, bot.driftDeg);
    stats.modes[bot.mode] = (stats.modes[bot.mode] ?? 0) + 1;
    if (Math.abs(bot.lateral) > bot.corridor + 0.35) stats.offCorridorFrames++;
    if (Math.abs(bot.lateral) > bot.hardLimit) stats.hardLimitHits++;
    if (Math.abs(bot.lateral) > HALF_WIDTH - 1.15) stats.offTrackFrames++;
    latSum += Math.abs(bot.lateral);
    frames++;

    if (prevT > 0.85 && bot.t < 0.15) lapsDone++;
    prevT = bot.t;
    lastYawRate = bot.yawRate;
    lastSteer = bot.steerAngle;
    prevSlipRate = bot.slipRate;
    lastLatVel = latVel;
    time += dt;
  }

  stats.laps = lapsDone;
  stats.time = time;
  stats.meanLat = frames ? latSum / frames : 0;
  stats.avgSpeed = time > 0 ? (sampler.length * lapsDone) / time : 0;
  stats.chatterPerSec = time > 0 ? flips / time : 0;
  return stats;
};

/* ----------------------------------------------------------------- tests */
const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
let pass = true;
const check = (name: string, ok: boolean, detail: string) => {
  pass = pass && ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(34)} ${detail}`);
};

const report = (tag: string, dt: number, s: RunStats) => {
  const lapsOk = s.laps >= 3;
  check(
    `laps ${tag}`,
    lapsOk,
    `laps=${s.laps} t=${s.time.toFixed(1)}s avg=${s.avgSpeed.toFixed(1)}m/s`
  );
  check(
    `line ${tag}`,
    s.maxLat < HALF_WIDTH - CAR_MARGIN - 0.45 && s.offCorridorFrames / Math.max(1, s.time / dt) < 0.05,
    `maxLat=${s.maxLat.toFixed(2)}m meanLat=${s.meanLat.toFixed(2)}m offCorridor=${s.offCorridorFrames}f`
  );
  check(
    `no wall scrape ${tag}`,
    s.hardLimitHits === 0 && s.offTrackFrames === 0,
    `hardHits=${s.hardLimitHits} offTrack=${s.offTrackFrames}f`
  );
  check(
    `smooth ${tag}`,
    s.maxSteerRate < 9.6 &&
      s.lineJerk < 120 &&
      s.yawJerk < 27 && // batas desain spring-damper slip (<= 26 rad/s^2)
      s.chatterPerSec < 0.7,
    `latAccel=${s.maxLatAccel.toFixed(1)} latJerk=${s.lineJerk.toFixed(1)} yawJerk=${s.yawJerk.toFixed(1)} chatter=${s.chatterPerSec.toFixed(2)}/s steerRate=${s.maxSteerRate.toFixed(1)}`
  );
  check(
    `drift alive ${tag}`,
    s.slipMaxDeg > 25 && s.slipMaxDeg < 85,
    `slipMax=${s.slipMaxDeg.toFixed(0)}deg modes=${JSON.stringify(s.modes)}`
  );
};

console.log('--- PRO DRIFT BOT v2 harness ---');
const s60 = runLaps('pro', 12345, 1 / 60, 3);
report('pro@60fps', 1 / 60, s60);
const s30 = runLaps('pro', 777, 1 / 30, 3);
report('pro@30fps', 1 / 30, s30);
const s20 = runLaps('pro', 99, 1 / 20, 3);
report('pro@20fps', 1 / 20, s20);
const sChill = runLaps('chill', 4242, 1 / 60, 3);
report('chill@60fps', 1 / 60, sChill);
const sLegend = runLaps('legend', 31337, 1 / 60, 3);
report('legend@60fps', 1 / 60, sLegend);

check(
  'pace ordering',
  sLegend.avgSpeed > s60.avgSpeed && s60.avgSpeed > sChill.avgSpeed,
  `legend=${sLegend.avgSpeed.toFixed(1)} pro=${s60.avgSpeed.toFixed(1)} chill=${sChill.avgSpeed.toFixed(1)} m/s`
);

/* ---- recovery: dibuang keluar jalur + heading salah, harus rejoin mulus --- */
{
  const personality = makePersonality(2024, 'pro');
  const lane = new LanePlan({
    sampler,
    clippingZones: zones,
    halfWidth: HALF_WIDTH,
    wallMargin: CAR_MARGIN + personality.wallMargin,
    lineGain: personality.lineGain,
    zoneGain: 0.9,
  });
  const pose = sampler.poseAtT(0.3, {
    x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: -1, nz: 0, curvature: 0, t: 0, dist: 0,
  });
  const bot = new ProDriftBot({
    personality,
    x: pose.x + pose.nx * 4.3,
    z: pose.z + pose.nz * 4.3,
    heading: Math.atan2(pose.tx, pose.tz) + 1.15,
    t: pose.t,
    halfWidth: HALF_WIDTH,
    carMargin: CAR_MARGIN,
  });
  const input: BotInput = {
    dt: 1 / 60,
    time: 0,
    raceStarted: true,
    halfWidth: HALF_WIDTH,
    carMargin: CAR_MARGIN,
    aLatScale: 1,
    speedFactor: 1,
    sampler,
    lane,
    playerVisible: false,
    playerT: 0,
    playerSpeed: 0,
    playerLateral: 0,
    playerHeading: 0,
  };
  let t = 0;
  let rejoinT = -1;
  let worstLat = 0;
  let maxJerk = 0;
  let lastLatVel = 0;
  while (t < 12) {
    input.time = t;
    bot.step(input);
    worstLat = Math.max(worstLat, Math.abs(bot.lateral));
    const latVel = Math.abs(bot.speed * Math.sin(bot.slip));
    maxJerk = Math.max(maxJerk, Math.abs(latVel - lastLatVel) * 60);
    lastLatVel = latVel;
    if (rejoinT < 0 && t > 0.5 && Math.abs(bot.lateral) < bot.corridor) rejoinT = t;
    t += 1 / 60;
  }
  check(
    'recover from off-line',
    rejoinT > 0 && rejoinT < 5 && worstLat < HALF_WIDTH + 0.4,
    `rejoin=${rejoinT.toFixed(2)}s worstLat=${worstLat.toFixed(2)}m jerk=${maxJerk.toFixed(1)}`
  );
}

/* ---- contact solver: tetap bisa nabrak tapi tidak mental ---------------- */
{
  const mkBody = (x: number, z: number, heading: number, speed: number): ContactBody => ({
    x,
    z,
    heading,
    velAngle: heading,
    speed,
    yawRate: 0,
  });
  const a = mkBody(0, -1.9, 0, 9.5); // pemain menghajar dari belakang
  const b = mkBody(0, 0, 0, 7.2);
  const out = makeContactResult();
  let maxCorr = 0;
  let maxImpulse = 0;
  let maxSpin = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) {
    const ax0 = a.x;
    const az0 = a.z;
    const bx0 = b.x;
    const bz0 = b.z;
    a.velAngle = a.heading;
    b.velAngle = b.heading;
    resolveRcContact(a, b, dt, {}, out);
    maxCorr = Math.max(maxCorr, Math.hypot(a.x - ax0, a.z - az0), Math.hypot(b.x - bx0, b.z - bz0));
    maxImpulse = Math.max(maxImpulse, out.impulse);
    maxSpin = Math.max(maxSpin, Math.abs(out.spinA), Math.abs(out.spinB));
    a.x += Math.sin(a.velAngle) * a.speed * dt;
    a.z += Math.cos(a.velAngle) * a.speed * dt;
    b.x += Math.sin(b.velAngle) * b.speed * dt;
    b.z += Math.cos(b.velAngle) * b.speed * dt;
    if (i === 40) {
      // pemain lepas gas: biarkan bot melanjutkan
      a.speed = 6.0;
    }
  }
  const gap = Math.hypot(a.x - b.x, a.z - b.z);
  check(
    'contact: can bump',
    maxImpulse > 1.2 && maxImpulse <= 5.6,
    `impulse=${maxImpulse.toFixed(2)} spin=${maxSpin.toFixed(2)}rad/s`
  );
  check(
    'contact: smooth + separated',
    maxCorr < 0.045 && gap > 1.6 && a.speed > 0.2 && a.speed < 30,
    `maxCorr=${maxCorr.toFixed(3)}m gap=${gap.toFixed(2)}m spdA=${a.speed.toFixed(2)} spdB=${b.speed.toFixed(2)}`
  );
}


/* ---- contact off-center: spin PIT terbatas tapi terasa ------------------ */
{
  const mkBody = (x: number, z: number, heading: number, speed: number): ContactBody => ({
    x, z, heading, velAngle: heading, speed, yawRate: 0,
  });
  const a = mkBody(0.85, -1.7, 0.06, 10.5);
  const b = mkBody(0, 0, 0, 7.0);
  const out = makeContactResult();
  let maxSpin = 0;
  let maxCorr = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) {
    const a0 = [a.x, a.z];
    const b0 = [b.x, b.z];
    a.velAngle = a.heading;
    b.velAngle = b.heading;
    b.heading += b.yawRate * dt;
    b.yawRate *= 0.9;
    resolveRcContact(a, b, dt, {}, out);
    maxSpin = Math.max(maxSpin, Math.abs(out.spinB));
    maxCorr = Math.max(maxCorr, Math.hypot(a.x - a0[0], a.z - a0[1]), Math.hypot(b.x - b0[0], b.z - b0[1]));
    a.x += Math.sin(a.velAngle) * a.speed * dt;
    a.z += Math.cos(a.velAngle) * a.speed * dt;
    b.x += Math.sin(b.velAngle) * b.speed * dt;
    b.z += Math.cos(b.velAngle) * b.speed * dt;
    a.speed = Math.max(0, a.speed - 2.5 * dt);
  }
  check(
    'contact: pit spin bounded',
    maxSpin > 0.02 && maxSpin <= 1.0 && maxCorr < 0.05,
    `maxSpin=${maxSpin.toFixed(3)}rad/s maxCorr=${maxCorr.toFixed(3)}m`
  );
}


/* ---- tandem: pemain menempel bot, tidak boleh ada hentakan/NaN -------- */
{
  const botPersonality = makePersonality(555, 'pro');
  const lane = new LanePlan({
    sampler,
    clippingZones: zones,
    halfWidth: HALF_WIDTH,
    wallMargin: CAR_MARGIN + botPersonality.wallMargin,
    lineGain: botPersonality.lineGain,
    zoneGain: 0.9,
  });
  const mkPose = () => ({ x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: -1, nz: 0, curvature: 0, t: 0, dist: 0 });
  const start = sampler.poseAtT(0.01, mkPose());
  const bot = new ProDriftBot({
    personality: botPersonality,
    x: start.x,
    z: start.z,
    heading: Math.atan2(start.tx, start.tz),
    t: start.t,
    halfWidth: HALF_WIDTH,
    carMargin: CAR_MARGIN,
  });
  const input: BotInput = {
    dt: 1 / 60,
    time: 0,
    raceStarted: true,
    halfWidth: HALF_WIDTH,
    carMargin: CAR_MARGIN,
    aLatScale: 1,
    speedFactor: 1,
    sampler,
    lane,
    playerVisible: true,
    playerT: 0,
    playerSpeed: 0,
    playerLateral: 0,
    playerHeading: 0,
  };

  // Pemain sederhana: pure-pursuit yang mengejar bot (kadang menabrak).
  const player: ContactBody = { x: 0, z: 0, heading: 0, velAngle: 0, speed: 0, yawRate: 0 };
  const pStart = sampler.poseAtT(0.995, mkPose());
  player.x = pStart.x + pStart.nx * 0.9;
  player.z = pStart.z + pStart.nz * 0.9;
  player.heading = Math.atan2(pStart.tx, pStart.tz);
  player.velAngle = player.heading;
  player.speed = 0;

  const out = makeContactResult();
  const dt = 1 / 60;
  let t = 0;
  let maxMove = 0;
  let contacts = 0;
  let nan = false;
  let maxGap = 0;
  let minGap = 99;
  let gapSum = 0;
  let gapSqSum = 0;
  let frames = 0;
  let pT = 0.995;
  const proj = { t: 0, dist: 0, lateral: 0, tangentX: 0, tangentZ: 1, curvature: 0, idx: 0 };

  while (t < 45) {
    input.time = t;
    input.playerT = pT;
    input.playerSpeed = player.speed;
    input.playerLateral = 0;
    bot.step(input);

    // Pemain mengejar titik di depan sepanjang garis balap.
    sampler.project(player.x, player.z, proj, -1);
    pT = proj.t;
    const pl = lane.offsetAt(proj.t);
    const look = 4 + player.speed * 0.42;
    const aheadT = ((proj.t + look / sampler.length) % 1 + 1) % 1;
    const ahead = sampler.poseAtT(aheadT, mkPose());
    const tx = ahead.x + ahead.nx * pl;
    const tz = ahead.z + ahead.nz * pl;
    const desired = Math.atan2(tx - player.x, tz - player.z);
    let err = desired - player.velAngle;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    player.velAngle += err * Math.min(1.6, 6 * dt);
    const gap = Math.hypot(bot.x - player.x, bot.z - player.z);
    // throttle: menempel di ~2 m, kadang sengaja nabrak saat t > 20
    const behind = bot.x * Math.sin(bot.heading) + bot.z * Math.cos(bot.heading) >
      player.x * Math.sin(bot.heading) + player.z * Math.cos(bot.heading);
    const chase = behind ? 1 : 0.98;
    const target = t > 20 && t < 24 ? 24 : 18 + Math.min(5, gap * 0.5);
    player.speed += clampNum((target * chase - player.speed) * 2.2, -14, 9) * dt;
    player.speed = clampNum(player.speed, 0, 30);

    // solver kontak yang sama dengan game
    const pb = { ...player, yawRate: 0 };
    const bb = { ...bot, x: bot.x, z: bot.z, heading: bot.heading, velAngle: bot.velAngle, speed: bot.speed, yawRate: 0 };
    const p0 = [pb.x, pb.z];
    resolveRcContact(pb, bb, dt, {}, out);
    if (out.hit) {
      contacts++;
      maxMove = Math.max(maxMove, Math.hypot(pb.x - p0[0], pb.z - p0[1]));
      bot.x = bb.x;
      bot.z = bb.z;
      bot.speed = bb.speed;
      bot.velAngle = bb.velAngle;
      bot.notifyContact(out.kind, false, out.spinB);
    }
    player.x = pb.x + Math.sin(pb.velAngle) * pb.speed * dt;
    player.z = pb.z + Math.cos(pb.velAngle) * pb.speed * dt;
    player.heading = pb.velAngle;

    if (!Number.isFinite(bot.x + bot.z + bot.speed + bot.heading + player.x + player.z)) nan = true;
    const rawGap = Math.hypot(bot.x - player.x, bot.z - player.z);
    maxGap = Math.max(maxGap, rawGap);
    minGap = Math.min(minGap, rawGap);
    if (rawGap < 15) {
      // hanya ukur fase tandem (saat pemain benar-benar menempel)
      gapSum += rawGap;
      gapSqSum += rawGap * rawGap;
      frames++;
    }
    t += dt;
  }
  const mean = gapSum / frames;
  const std = Math.sqrt(Math.max(0, gapSqSum / frames - mean * mean));
  check(
    'tandem battle: stable',
    !nan && contacts > 2 && maxMove < 0.05 && minGap > 1.5 && std < 4.5 && Math.abs(bot.lateral) < 4.2,
    `contacts=${contacts} maxMove=${maxMove.toFixed(3)}m gap=${minGap.toFixed(2)}-${maxGap.toFixed(2)}m tandemStd=${std.toFixed(2)} botLat=${bot.lateral.toFixed(2)}`
  );
}

/* ---- variasi: seed berbeda -> garis berbeda (tidak gampang ditebak) ----- */
{
  const lineSamples = (seed: number) => {
    const personality = makePersonality(seed, 'pro');
    const lane = new LanePlan({
      sampler,
      clippingZones: zones,
      halfWidth: HALF_WIDTH,
      wallMargin: CAR_MARGIN + personality.wallMargin,
      lineGain: personality.lineGain,
      zoneGain: 0.9,
    });
    const start = sampler.poseAtT(0.01, {
      x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: -1, nz: 0, curvature: 0, t: 0, dist: 0,
    });
    const bot = new ProDriftBot({
      personality,
      x: start.x,
      z: start.z,
      heading: Math.atan2(start.tx, start.tz),
      t: start.t,
      halfWidth: HALF_WIDTH,
      carMargin: CAR_MARGIN,
    });
    const input: BotInput = {
      dt: 1 / 60,
      time: 0,
      raceStarted: true,
      halfWidth: HALF_WIDTH,
      carMargin: CAR_MARGIN,
      aLatScale: 1,
      speedFactor: 1,
      sampler,
      lane,
      playerVisible: false,
      playerT: 0,
      playerSpeed: 0,
      playerLateral: 0,
      playerHeading: 0,
    };
    const samples: number[] = [];
    const poses: number[][] = [];
    for (let i = 0; i < 900; i++) {
      input.time = i / 60;
      bot.step(input);
      if (i % 10 === 0) {
        samples.push(bot.lateral);
        poses.push([bot.x, bot.z, bot.heading]);
      }
    }
    return { samples, poses };
  };
  const s1 = lineSamples(11);
  const s2 = lineSamples(22);
  let diff = 0;
  for (let i = 0; i < s1.samples.length; i++) diff += Math.abs(s1.samples[i] - s2.samples[i]);
  diff /= s1.samples.length;
  const poseDiff =
    s1.poses.reduce((acc, p, i) => acc + Math.hypot(p[0] - s2.poses[i][0], p[1] - s2.poses[i][1]), 0) /
    s1.poses.length;
  check(
    'variety (anti predictable)',
    diff > 0.05 && poseDiff > 0.15,
    `lineDiff=${diff.toFixed(3)}m poseDiff=${poseDiff.toFixed(2)}m`
  );
}

console.log(pass ? '\nALL PASS' : '\nSOME TESTS FAILED');
process.exit(pass ? 0 : 1);
