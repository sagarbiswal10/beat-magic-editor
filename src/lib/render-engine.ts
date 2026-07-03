import type { EditPlanT } from "./director.functions";

export type MediaItem =
  | { kind: "image"; el: HTMLImageElement; url: string; name: string }
  | { kind: "video"; el: HTMLVideoElement; url: string; name: string; duration: number };

export interface RenderConfig {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  media: MediaItem[];
  cutTimes: number[]; // cut points, relative to segment start (0 = first frame)
  plan: EditPlanT;
  audioStartSec: number;
  totalDurationSec: number;
  captionHook?: string;
  captionOutro?: string;
}

const COLOR_GRADES: Record<EditPlanT["colorGrade"], { color: string; alpha: number; blend: GlobalCompositeOperation }> = {
  "warm-romantic": { color: "#ff9a5a", alpha: 0.12, blend: "overlay" },
  "vibrant-party": { color: "#ff2fa8", alpha: 0.10, blend: "overlay" },
  "cinematic-teal": { color: "#00e5ff", alpha: 0.10, blend: "overlay" },
  "golden-hour": { color: "#ffb340", alpha: 0.14, blend: "soft-light" },
  "vintage-film": { color: "#d4a574", alpha: 0.15, blend: "multiply" },
};

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Draw a media item with cover-fit + optional Ken Burns transform.
 * progress: 0-1 within segment. */
function drawMedia(
  ctx: CanvasRenderingContext2D,
  media: MediaItem,
  W: number,
  H: number,
  progress: number,
  motionStyle: EditPlanT["motionStyle"],
  extraScale = 1,
  extraOffsetX = 0,
  extraOffsetY = 0,
  extraAlpha = 1,
  extraRotation = 0,
) {
  const src = media.el as HTMLImageElement | HTMLVideoElement;
  const srcW = media.kind === "image" ? (src as HTMLImageElement).naturalWidth : (src as HTMLVideoElement).videoWidth;
  const srcH = media.kind === "image" ? (src as HTMLImageElement).naturalHeight : (src as HTMLVideoElement).videoHeight;
  if (!srcW || !srcH) return;

  // Ken Burns scale/pan
  let baseScale = 1;
  let panX = 0;
  let panY = 0;
  if (motionStyle === "ken-burns-slow") {
    baseScale = 1 + 0.06 * progress;
    panX = (progress - 0.5) * 0.04;
  } else if (motionStyle === "ken-burns-fast") {
    baseScale = 1 + 0.12 * progress;
    panX = (progress - 0.5) * 0.08;
  } else if (motionStyle === "punch-zoom") {
    baseScale = 1.15 - 0.10 * progress;
  } else if (motionStyle === "parallax-drift") {
    panX = (progress - 0.5) * 0.10;
    panY = Math.sin(progress * Math.PI) * 0.02;
  }
  const scale = baseScale * extraScale;

  // cover-fit
  const srcRatio = srcW / srcH;
  const dstRatio = W / H;
  let drawW: number, drawH: number;
  if (srcRatio > dstRatio) {
    drawH = H * scale;
    drawW = drawH * srcRatio;
  } else {
    drawW = W * scale;
    drawH = drawW / srcRatio;
  }
  const dx = (W - drawW) / 2 + panX * W + extraOffsetX;
  const dy = (H - drawH) / 2 + panY * H + extraOffsetY;

  ctx.save();
  ctx.globalAlpha = extraAlpha;
  if (extraRotation !== 0) {
    ctx.translate(W / 2, H / 2);
    ctx.rotate(extraRotation);
    ctx.translate(-W / 2, -H / 2);
  }
  try {
    ctx.drawImage(src, dx, dy, drawW, drawH);
  } catch (e) {
    // video not ready yet
  }
  ctx.restore();
}

/** Render one frame of the full timeline at `timeSec` into `ctx`. */
export function renderFrame(cfg: RenderConfig, timeSec: number) {
  const ctx = cfg.canvas.getContext("2d");
  if (!ctx) return;
  const { width: W, height: H, cutTimes, media, plan } = cfg;

  // Fill background
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  if (media.length === 0) return;

  // Build segment boundaries: [0, beats[0], beats[1], ..., totalDuration]
  const bounds = [0, ...cutTimes, cfg.totalDurationSec];
  // Find current segment
  let segIdx = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    if (timeSec >= bounds[i] && timeSec < bounds[i + 1]) {
      segIdx = i;
      break;
    }
    if (i === bounds.length - 2) segIdx = i;
  }
  const segStart = bounds[segIdx];
  const segEnd = bounds[segIdx + 1];
  const segDur = Math.max(0.001, segEnd - segStart);
  const localT = Math.min(1, Math.max(0, (timeSec - segStart) / segDur));

  const currentMedia = media[segIdx % media.length];
  const prevMedia = segIdx > 0 ? media[(segIdx - 1) % media.length] : null;

  // Transition happens in first ~350ms of the segment (starting at the beat)
  const TRANS_DUR = Math.min(0.38, segDur * 0.45);
  const inTransition = segIdx > 0 && timeSec - segStart < TRANS_DUR;
  const transition = plan.transitions[segIdx - 1];

  if (inTransition && transition && prevMedia) {
    const tRaw = (timeSec - segStart) / TRANS_DUR;
    const t = easeInOut(tRaw);
    applyTransition(ctx, W, H, prevMedia, currentMedia, t, transition.type, plan.motionStyle, localT);
  } else {
    drawMedia(ctx, currentMedia, W, H, localT, plan.motionStyle);
  }

  // Color grade overlay
  const grade = COLOR_GRADES[plan.colorGrade];
  ctx.save();
  ctx.globalCompositeOperation = grade.blend;
  ctx.globalAlpha = grade.alpha;
  ctx.fillStyle = grade.color;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Vignette
  const vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.max(W, H) * 0.75);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  // Hero-beat pulse (subtle bloom, no flash if the transition already flashes)
  if (inTransition && transition?.isHero && transition.type !== "flash-white" && transition.type !== "flash-black") {
    const pulse = (1 - (timeSec - segStart) / TRANS_DUR) * 0.18;
    ctx.fillStyle = `rgba(255,255,255,${pulse})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Captions
  if (segIdx === 0 && cfg.captionHook) {
    const fadeIn = Math.min(1, localT * 2);
    const fadeOut = Math.min(1, (1 - localT) * 3);
    drawCaption(ctx, W, H, cfg.captionHook, Math.min(fadeIn, fadeOut), "hook");
  }
  if (segIdx === bounds.length - 2 && cfg.captionOutro) {
    const fadeIn = Math.min(1, localT * 3);
    drawCaption(ctx, W, H, cfg.captionOutro, fadeIn, "outro");
  }
}

function applyTransition(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  prev: MediaItem,
  curr: MediaItem,
  t: number,
  type: EditPlanT["transitions"][number]["type"],
  motionStyle: EditPlanT["motionStyle"],
  currentSegProgress: number,
) {
  switch (type) {
    case "cut":
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle);
      break;
    case "cross-dissolve": {
      drawMedia(ctx, prev, W, H, 1, motionStyle, 1, 0, 0, 1 - t);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, 1, 0, 0, t);
      break;
    }
    case "blur-fade": {
      ctx.save();
      ctx.filter = `blur(${(1 - t) * 12}px)`;
      drawMedia(ctx, prev, W, H, 1, motionStyle, 1, 0, 0, 1 - t);
      ctx.filter = `blur(${t * 12}px)`;
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, 1, 0, 0, t);
      ctx.restore();
      break;
    }
    case "zoom-punch": {
      const prevScale = 1 + t * 0.6;
      const currScale = 1.8 - t * 0.8;
      drawMedia(ctx, prev, W, H, 1, motionStyle, prevScale, 0, 0, 1 - t);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, currScale, 0, 0, t);
      break;
    }
    case "flash-white": {
      if (t < 0.5) {
        drawMedia(ctx, prev, W, H, 1, motionStyle);
      } else {
        drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle);
      }
      const flashA = 1 - Math.abs(t - 0.5) * 2;
      ctx.fillStyle = `rgba(255,255,255,${flashA})`;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "flash-black": {
      if (t < 0.5) {
        drawMedia(ctx, prev, W, H, 1, motionStyle);
      } else {
        drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle);
      }
      const flashA = 1 - Math.abs(t - 0.5) * 2;
      ctx.fillStyle = `rgba(0,0,0,${flashA})`;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "push-left": {
      drawMedia(ctx, prev, W, H, 1, motionStyle, 1, -t * W, 0, 1);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, 1, (1 - t) * W, 0, 1);
      break;
    }
    case "push-right": {
      drawMedia(ctx, prev, W, H, 1, motionStyle, 1, t * W, 0, 1);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, 1, -(1 - t) * W, 0, 1);
      break;
    }
    case "push-up": {
      drawMedia(ctx, prev, W, H, 1, motionStyle, 1, 0, -t * H, 1);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, 1, 0, (1 - t) * H, 1);
      break;
    }
    case "morph-zoom": {
      ctx.save();
      ctx.filter = `blur(${(1 - t) * 6 + t * 4}px)`;
      const prevScale = 1 + t * 1.4;
      const currScale = 2.2 - t * 1.2;
      drawMedia(ctx, prev, W, H, 1, motionStyle, prevScale, 0, 0, 1 - t);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, currScale, 0, 0, t);
      ctx.restore();
      break;
    }
    case "light-leak": {
      drawMedia(ctx, prev, W, H, 1, motionStyle, 1, 0, 0, 1 - t);
      drawMedia(ctx, curr, W, H, currentSegProgress, motionStyle, 1, 0, 0, t);
      // Warm horizontal leak sweeping across
      const cx = t * W * 1.4 - W * 0.2;
      const grad = ctx.createRadialGradient(cx, H * 0.5, 0, cx, H * 0.5, W * 0.7);
      const bloom = 1 - Math.abs(t - 0.5) * 2;
      grad.addColorStop(0, `rgba(255,210,140,${0.55 * bloom})`);
      grad.addColorStop(0.4, `rgba(255,150,80,${0.28 * bloom})`);
      grad.addColorStop(1, "rgba(255,120,60,0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }
    case "film-burn": {
      drawMedia(ctx, t < 0.5 ? prev : curr, W, H, currentSegProgress, motionStyle);
      const burn = 1 - Math.abs(t - 0.5) * 2;
      const cx = W * (0.3 + 0.4 * t);
      const cy = H * (0.4 + 0.2 * (t - 0.5));
      const r = W * (0.15 + 0.7 * t);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(255,255,240,${0.9 * burn})`);
      grad.addColorStop(0.3, `rgba(255,180,90,${0.7 * burn})`);
      grad.addColorStop(0.7, `rgba(180,40,20,${0.35 * burn})`);
      grad.addColorStop(1, "rgba(20,0,0,0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }
    case "glitch": {
      drawMedia(ctx, t < 0.5 ? prev : curr, W, H, currentSegProgress, motionStyle);
      // RGB split slices
      const slices = 8;
      for (let i = 0; i < slices; i++) {
        const y = (i / slices) * H;
        const h = H / slices;
        const dx = (Math.random() - 0.5) * 40 * (1 - Math.abs(t - 0.5) * 2);
        const slice = ctx.getImageData(0, y, W, h);
        ctx.putImageData(slice, dx, y);
      }
      break;
    }
  }
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  text: string,
  alpha: number,
  kind: "hook" | "outro",
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const fontSize = Math.floor(Math.min(W, H) * (kind === "hook" ? 0.09 : 0.075));
  ctx.font = `900 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cy = kind === "hook" ? H * 0.85 : H * 0.5;
  ctx.lineWidth = fontSize * 0.08;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.fillStyle = "#fff";
  ctx.strokeText(text, W / 2, cy);
  ctx.fillText(text, W / 2, cy);
  ctx.restore();
}

/** Load a File as HTMLImageElement or HTMLVideoElement. */
export async function loadMediaItem(file: File): Promise<MediaItem> {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("image/")) {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.src = url;
    await new Promise<void>((resolve, reject) => {
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${file.name}`));
    });
    return { kind: "image", el, url, name: file.name };
  } else if (file.type.startsWith("video/")) {
    const el = document.createElement("video");
    el.src = url;
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${file.name}`));
    });
    return { kind: "video", el, url, name: file.name, duration: el.duration };
  }
  throw new Error(`Unsupported file type: ${file.type}`);
}

/** Export the composition to a Blob (WebM/MP4 depending on browser) via MediaRecorder. */
export async function exportVideo(
  cfg: RenderConfig,
  audioBuffer: AudioBuffer,
  audioStartSec: number,
  audioEndSec: number,
  audioFadeInSec: number,
  audioFadeOutSec: number,
  audioVolume: number,
  fps: number,
  onProgress: (p: number) => void,
): Promise<Blob> {
  const durationSec = audioEndSec - audioStartSec;

  // Prepare audio graph via a live AudioContext feeding both destination and MediaStreamDestination
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const streamDest = audioCtx.createMediaStreamDestination();

  // Song source
  const songBufferTrimmed = trimBuffer(audioCtx, audioBuffer, audioStartSec, audioEndSec);
  const songSrc = audioCtx.createBufferSource();
  songSrc.buffer = songBufferTrimmed;
  const songGain = audioCtx.createGain();
  songGain.gain.value = audioVolume;
  // Fades
  const now0 = audioCtx.currentTime + 0.05;
  if (audioFadeInSec > 0) {
    songGain.gain.setValueAtTime(0, now0);
    songGain.gain.linearRampToValueAtTime(audioVolume, now0 + audioFadeInSec);
  }
  if (audioFadeOutSec > 0) {
    songGain.gain.setValueAtTime(audioVolume, now0 + durationSec - audioFadeOutSec);
    songGain.gain.linearRampToValueAtTime(0, now0 + durationSec);
  }
  songSrc.connect(songGain).connect(streamDest);

  // Canvas stream
  const canvasStream = (cfg.canvas as HTMLCanvasElement).captureStream(fps);
  const combined = new MediaStream([...canvasStream.getVideoTracks(), ...streamDest.stream.getAudioTracks()]);

  const mimeCandidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

  recorder.start(200);
  songSrc.start(now0);

  // Start any videos in media
  for (const m of cfg.media) {
    if (m.kind === "video") {
      m.el.currentTime = 0;
      try {
        await m.el.play();
      } catch {}
    }
  }

  const startWall = performance.now();
  const totalMs = durationSec * 1000;
  const frameInterval = 1000 / fps;
  let lastFrame = 0;

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - startWall;
      const t = elapsed / 1000;
      if (elapsed - lastFrame >= frameInterval - 1) {
        lastFrame = elapsed;
        renderFrame(cfg, t);
        onProgress(Math.min(1, elapsed / totalMs));
      }
      if (elapsed < totalMs) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  songSrc.stop();
  for (const m of cfg.media) {
    if (m.kind === "video") m.el.pause();
  }
  const blob = await done;
  await audioCtx.close();
  return blob;
}

function trimBuffer(ctx: AudioContext, src: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = src.sampleRate;
  const startFrame = Math.floor(startSec * sr);
  const endFrame = Math.floor(endSec * sr);
  const len = endFrame - startFrame;
  const out = ctx.createBuffer(src.numberOfChannels, len, sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const dst = out.getChannelData(c);
    const s = src.getChannelData(c);
    for (let i = 0; i < len; i++) dst[i] = s[startFrame + i] ?? 0;
  }
  return out;
}

export const ASPECT_RATIOS = {
  "9:16": { width: 720, height: 1280, label: "Reels / TikTok" },
  "1:1": { width: 1080, height: 1080, label: "Square" },
  "16:9": { width: 1280, height: 720, label: "YouTube" },
  "4:5": { width: 864, height: 1080, label: "Portrait Feed" },
} as const;

export type AspectKey = keyof typeof ASPECT_RATIOS;