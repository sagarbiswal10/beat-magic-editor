// Web Audio API onset/beat detection using low-frequency energy peaks.
// Runs entirely in the browser. Not tone.js-accurate, but reliable for edit sync.

export interface BeatAnalysis {
  durationSec: number;
  bpm: number;
  beats: number[]; // seconds, absolute in the buffer
  heroBeats: number[]; // subset — high-energy drops
  energyCurve: number[]; // length 32-64, normalized 0-1 across full duration
  brightnessCurve: number[]; // spectral brightness (zero-crossing rate) 0-1
  dynamicRange: number; // 0-1, how much loud vs soft variation
  tempoStability: number; // 0-1, how consistent the beat interval is
  quietRatio: number; // 0-1, fraction of section that is quiet
  peakDensity: number; // beats per second
  fingerprint: string; // deterministic short hash of this song section
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  await ctx.close();
  return buffer;
}

export function analyzeBeats(buffer: AudioBuffer, startSec = 0, endSec?: number): BeatAnalysis {
  const end = endSec ?? buffer.duration;
  const sampleRate = buffer.sampleRate;
  const startFrame = Math.floor(startSec * sampleRate);
  const endFrame = Math.floor(end * sampleRate);
  const totalFrames = endFrame - startFrame;
  const channelData = buffer.getChannelData(0);

  // Window size: ~23ms
  const windowSize = Math.floor(sampleRate * 0.023);
  const windowCount = Math.floor(totalFrames / windowSize);

  // Low-pass energy per window (approximation: sum of squared samples, we bias
  // toward low freq by downsampling — beats typically kick/bass at <200Hz)
  const energies: number[] = new Array(windowCount);
  const brightness: number[] = new Array(windowCount);
  for (let i = 0; i < windowCount; i++) {
    let sum = 0;
    let zc = 0;
    let prev = 0;
    const s = startFrame + i * windowSize;
    for (let j = 0; j < windowSize; j++) {
      const v = channelData[s + j];
      sum += v * v;
      if ((v >= 0) !== (prev >= 0)) zc++;
      prev = v;
    }
    energies[i] = sum / windowSize;
    brightness[i] = zc / windowSize;
  }

  // Onset detection: flag windows whose energy exceeds moving avg * threshold
  const avgWindow = 43; // ~1s history
  const beats: number[] = [];
  const beatEnergies: number[] = [];
  const minGap = Math.floor(sampleRate * 0.18 / windowSize); // 180ms refractory
  let lastBeat = -minGap;

  for (let i = avgWindow; i < windowCount; i++) {
    let avg = 0;
    for (let k = i - avgWindow; k < i; k++) avg += energies[k];
    avg /= avgWindow;

    const threshold = avg * 1.55 + 1e-6;
    if (energies[i] > threshold && i - lastBeat >= minGap) {
      const timeSec = startSec + (i * windowSize) / sampleRate;
      beats.push(timeSec);
      beatEnergies.push(energies[i]);
      lastBeat = i;
    }
  }

  // BPM estimation from median inter-beat interval
  let bpm = 120;
  if (beats.length > 3) {
    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    if (median > 0) bpm = Math.round(60 / median);
    // fold into 60-180 range
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    bpm = Math.round(bpm);
  }

  // Hero beats: top 25% by energy, at least 2s apart
  const sortedE = [...beatEnergies].sort((a, b) => b - a);
  const heroThreshold = sortedE[Math.floor(sortedE.length * 0.2)] ?? 0;
  const heroBeats: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    if (beatEnergies[i] >= heroThreshold) {
      if (heroBeats.length === 0 || beats[i] - heroBeats[heroBeats.length - 1] >= 2) {
        heroBeats.push(beats[i]);
      }
    }
  }

  // Energy curve: downsample to 48 buckets, normalize 0-1
  const buckets = 48;
  const curve: number[] = new Array(buckets).fill(0);
  const perBucket = windowCount / buckets;
  for (let b = 0; b < buckets; b++) {
    let sum = 0;
    let n = 0;
    const s = Math.floor(b * perBucket);
    const e = Math.floor((b + 1) * perBucket);
    for (let k = s; k < e; k++) {
      sum += energies[k];
      n++;
    }
    curve[b] = n > 0 ? sum / n : 0;
  }
  const maxE = Math.max(...curve, 1e-6);
  const energyCurve = curve.map((v) => v / maxE);

  const bcurve: number[] = new Array(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    let sum = 0;
    let n = 0;
    const s = Math.floor(b * perBucket);
    const e = Math.floor((b + 1) * perBucket);
    for (let k = s; k < e; k++) {
      sum += brightness[k];
      n++;
    }
    bcurve[b] = n > 0 ? sum / n : 0;
  }
  const maxB = Math.max(...bcurve, 1e-6);
  const brightnessCurve = bcurve.map((v) => v / maxB);

  const meanE = energyCurve.reduce((a, b) => a + b, 0) / energyCurve.length;
  const varE = energyCurve.reduce((a, b) => a + (b - meanE) ** 2, 0) / energyCurve.length;
  const dynamicRange = Math.min(1, Math.sqrt(varE) * 2);

  let tempoStability = 0.5;
  if (beats.length > 3) {
    const ivs: number[] = [];
    for (let i = 1; i < beats.length; i++) ivs.push(beats[i] - beats[i - 1]);
    const m = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    const v = ivs.reduce((a, b) => a + (b - m) ** 2, 0) / ivs.length;
    tempoStability = Math.max(0, 1 - Math.sqrt(v) / (m || 1));
  }

  const quietRatio = energyCurve.filter((v) => v < 0.25).length / energyCurve.length;
  const peakDensity = beats.length / Math.max(0.1, end - startSec);

  const fpSrc = [
    ...energyCurve.map((v) => Math.round(v * 15)),
    ...brightnessCurve.map((v) => Math.round(v * 15)),
    Math.round(bpm),
    Math.round(dynamicRange * 100),
  ].join(",");
  let h = 2166136261;
  for (let i = 0; i < fpSrc.length; i++) {
    h ^= fpSrc.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const fingerprint = (h >>> 0).toString(36);

  return {
    durationSec: end - startSec,
    bpm,
    beats,
    heroBeats,
    energyCurve,
    brightnessCurve,
    dynamicRange,
    tempoStability,
    quietRatio,
    peakDensity,
    fingerprint,
  };
}

/** Find the most energetic continuous window of `windowSec` seconds. */
export function findBestWindow(buffer: AudioBuffer, windowSec: number): { start: number; end: number } {
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const bucketSec = 0.5;
  const bucketFrames = Math.floor(sampleRate * bucketSec);
  const bucketCount = Math.floor(channelData.length / bucketFrames);
  const bucketEnergy: number[] = [];
  for (let b = 0; b < bucketCount; b++) {
    let sum = 0;
    const s = b * bucketFrames;
    for (let j = 0; j < bucketFrames; j += 8) sum += channelData[s + j] * channelData[s + j];
    bucketEnergy.push(sum);
  }
  const windowBuckets = Math.floor(windowSec / bucketSec);
  if (windowBuckets >= bucketCount) return { start: 0, end: buffer.duration };
  let bestStart = 0;
  let bestSum = -Infinity;
  let running = 0;
  for (let i = 0; i < windowBuckets; i++) running += bucketEnergy[i];
  bestSum = running;
  for (let i = windowBuckets; i < bucketCount; i++) {
    running += bucketEnergy[i] - bucketEnergy[i - windowBuckets];
    if (running > bestSum) {
      bestSum = running;
      bestStart = i - windowBuckets + 1;
    }
  }
  const startSec = bestStart * bucketSec;
  return { start: startSec, end: Math.min(buffer.duration, startSec + windowSec) };
}

/**
 * Choose a sparse, musical subset of beats to use as actual cut points.
 * Every hero beat is included, then high-energy beats fill gaps.
 * Keeps a minimum gap so cuts breathe (default 1.2s ≈ pro reel pacing).
 */
export function selectCutBeats(
  a: BeatAnalysis,
  startSec: number,
  endSec: number,
  opts: { minGapSec?: number; targetSecPerCut?: number } = {},
): number[] {
  const minGap = opts.minGapSec ?? 1.2;
  const targetSec = opts.targetSecPerCut ?? 1.8;
  const inRange = (t: number) => t > startSec + 0.15 && t < endSec - 0.15;
  const dur = Math.max(0.1, endSec - startSec);

  // Score each beat: hero + local energy from curve
  const scored = a.beats
    .filter(inRange)
    .map((t) => {
      const rel = (t - startSec) / dur;
      const idx = Math.min(a.energyCurve.length - 1, Math.floor(rel * a.energyCurve.length));
      const energy = a.energyCurve[idx] ?? 0.5;
      const isHero = a.heroBeats.includes(t);
      return { t, score: energy + (isHero ? 1 : 0), isHero };
    });

  // Greedy pick highest-scoring beats first, honouring minGap
  const chosen: number[] = [];
  const targetCount = Math.max(2, Math.round(dur / targetSec));
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  for (const b of byScore) {
    if (chosen.length >= targetCount) break;
    if (chosen.every((c) => Math.abs(c - b.t) >= minGap)) chosen.push(b.t);
  }
  return chosen.sort((x, y) => x - y);
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  opts: { color?: string; bg?: string; startSec?: number; endSec?: number } = {},
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.fillStyle = opts.bg ?? "transparent";
  ctx.clearRect(0, 0, width, height);
  if (opts.bg) ctx.fillRect(0, 0, width, height);

  const data = buffer.getChannelData(0);
  const startFrame = Math.floor((opts.startSec ?? 0) * buffer.sampleRate);
  const endFrame = Math.floor((opts.endSec ?? buffer.duration) * buffer.sampleRate);
  const total = endFrame - startFrame;
  const step = Math.floor(total / width);
  ctx.fillStyle = opts.color ?? "#f59e0b";
  const mid = height / 2;
  for (let x = 0; x < width; x++) {
    let min = 1;
    let max = -1;
    const s = startFrame + x * step;
    for (let j = 0; j < step; j += 4) {
      const v = data[s + j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid;
    const y2 = mid + max * mid;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}