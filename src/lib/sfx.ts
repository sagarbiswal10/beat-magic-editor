// Procedural SFX generation — no external audio files needed.
// Renders whoosh/impact/riser into a shared AudioContext.

export type SfxKind = "whoosh" | "impact" | "riser" | "none";

export function scheduleSfx(
  ctx: AudioContext | OfflineAudioContext,
  destination: AudioNode,
  kind: SfxKind,
  timeSec: number,
  intensity = 1,
): void {
  if (kind === "none") return;
  const t0 = timeSec;
  if (kind === "whoosh") {
    const bufferLen = Math.floor(ctx.sampleRate * 0.4);
    const noiseBuf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(400, t0);
    filter.frequency.exponentialRampToValueAtTime(4000, t0 + 0.35);
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.5 * intensity, t0 + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.38);
    src.connect(filter).connect(gain).connect(destination);
    src.start(t0);
    src.stop(t0 + 0.4);
  } else if (kind === "impact") {
    // Kick-style thump
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.15);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.9 * intensity, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    osc.connect(gain).connect(destination);
    osc.start(t0);
    osc.stop(t0 + 0.28);
    // click
    const bufferLen = Math.floor(ctx.sampleRate * 0.05);
    const noiseBuf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) d[i] = (Math.random() * 2 - 1) * 0.8;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const cgain = ctx.createGain();
    cgain.gain.setValueAtTime(0.4 * intensity, t0);
    cgain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.04);
    src.connect(cgain).connect(destination);
    src.start(t0);
  } else if (kind === "riser") {
    const dur = 0.8;
    const bufferLen = Math.floor(ctx.sampleRate * dur);
    const noiseBuf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(200, t0);
    filter.frequency.exponentialRampToValueAtTime(8000, t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.4 * intensity, t0 + dur - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(gain).connect(destination);
    src.start(t0);
    src.stop(t0 + dur);
  }
}