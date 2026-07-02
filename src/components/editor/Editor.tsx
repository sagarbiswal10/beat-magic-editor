import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast, Toaster } from "sonner";
import {
  Film,
  Upload,
  Music,
  Sparkles,
  Play,
  Pause,
  Download,
  Wand2,
  Loader2,
  X,
  Image as ImageIcon,
  Video,
  Scissors,
  Crop,
  Heart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  analyzeBeats,
  decodeAudioFile,
  drawWaveform,
  findBestWindow,
  type BeatAnalysis,
} from "@/lib/beat-detection";
import {
  ASPECT_RATIOS,
  exportVideo,
  loadMediaItem,
  renderFrame,
  type AspectKey,
  type MediaItem,
} from "@/lib/render-engine";
import { scheduleSfx } from "@/lib/sfx";
import { generateEditPlan, type EditPlanT } from "@/lib/director.functions";

const OCCASIONS = ["Wedding", "Birthday", "Anniversary", "Party", "Baby Shower", "Graduation", "Travel"] as const;

export function Editor() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [audioTrim, setAudioTrim] = useState<[number, number]>([0, 30]);
  const [audioVolume, setAudioVolume] = useState(0.9);
  const [fadeIn, setFadeIn] = useState(0.3);
  const [fadeOut, setFadeOut] = useState(0.8);
  const [occasion, setOccasion] = useState<string>("Wedding");
  const [aspect, setAspect] = useState<AspectKey>("9:16");
  const [beatAnalysis, setBeatAnalysis] = useState<BeatAnalysis | null>(null);
  const [plan, setPlan] = useState<EditPlanT | null>(null);
  const [isDirecting, setIsDirecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewStartWallRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const dims = ASPECT_RATIOS[aspect];
  const directorFn = useServerFn(generateEditPlan);

  const durationSec = audioTrim[1] - audioTrim[0];

  // ---- Uploads ----
  const onMediaFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!arr.length) return;
    toast.loading(`Loading ${arr.length} file${arr.length > 1 ? "s" : ""}...`, { id: "load" });
    try {
      const items = await Promise.all(arr.map(loadMediaItem));
      setMedia((prev) => [...prev, ...items]);
      toast.success(`Added ${items.length} clip${items.length > 1 ? "s" : ""}`, { id: "load" });
    } catch (e) {
      toast.error((e as Error).message, { id: "load" });
    }
  }, []);

  const onAudioFile = useCallback(async (file: File) => {
    setAudioFile(file);
    toast.loading("Analyzing audio...", { id: "audio" });
    try {
      const buffer = await decodeAudioFile(file);
      setAudioBuffer(buffer);
      setAudioTrim([0, Math.min(30, buffer.duration)]);
      setPlan(null);
      setBeatAnalysis(null);
      toast.success(`Loaded ${file.name} (${buffer.duration.toFixed(1)}s)`, { id: "audio" });
    } catch (e) {
      toast.error("Could not decode audio: " + (e as Error).message, { id: "audio" });
    }
  }, []);

  const autoPickBest = useCallback(() => {
    if (!audioBuffer) return;
    const { start, end } = findBestWindow(audioBuffer, Math.min(30, audioBuffer.duration));
    setAudioTrim([start, end]);
    setPlan(null);
    toast.success(`Auto-picked best ${(end - start).toFixed(0)}s`);
  }, [audioBuffer]);

  // ---- Waveform draw ----
  useEffect(() => {
    if (!audioBuffer || !waveformRef.current) return;
    const c = waveformRef.current;
    c.width = c.clientWidth * devicePixelRatio;
    c.height = c.clientHeight * devicePixelRatio;
    drawWaveform(c, audioBuffer, { color: "rgba(245,158,11,0.65)" });
  }, [audioBuffer]);

  // ---- AI Director ----
  const runDirector = useCallback(async () => {
    if (!audioBuffer || media.length < 2) {
      toast.error("Add at least 2 photos/videos and a song first");
      return;
    }
    setIsDirecting(true);
    toast.loading("Analyzing beats + directing your edit...", { id: "director" });
    try {
      const analysis = analyzeBeats(audioBuffer, audioTrim[0], audioTrim[1]);
      setBeatAnalysis(analysis);
      const relBeats = analysis.beats.map((b) => b - audioTrim[0]);
      const relHero = analysis.heroBeats.map((b) => b - audioTrim[0]);
      const result = await directorFn({
        data: {
          occasion,
          aspectRatio: aspect,
          mediaCount: media.length,
          audio: {
            durationSec: durationSec,
            bpm: analysis.bpm,
            beatCount: relBeats.length,
            energyCurve: analysis.energyCurve,
            heroBeatTimes: relHero,
            startSec: audioTrim[0],
            endSec: audioTrim[1],
          },
        },
      });
      setPlan(result);
      toast.success(`AI directed: "${result.styleName}" — ${relBeats.length} beat-cuts`, { id: "director" });
    } catch (e) {
      toast.error("Director failed: " + (e as Error).message, { id: "director" });
    } finally {
      setIsDirecting(false);
    }
  }, [audioBuffer, media.length, audioTrim, occasion, aspect, durationSec, directorFn]);

  // ---- Build render config ----
  const renderCfg = useMemo(() => {
    if (!canvasRef.current || !beatAnalysis || !plan || media.length === 0) return null;
    const relBeats = beatAnalysis.beats.map((b) => b - audioTrim[0]).filter((b) => b > 0.05 && b < durationSec);
    return {
      canvas: canvasRef.current,
      width: dims.width,
      height: dims.height,
      media,
      beats: relBeats,
      plan,
      audioStartSec: audioTrim[0],
      totalDurationSec: durationSec,
      captionHook: plan.captionHook,
      captionOutro: plan.captionOutro,
    };
  }, [beatAnalysis, plan, media, dims, audioTrim, durationSec]);

  // Sync canvas dims
  useEffect(() => {
    if (!canvasRef.current) return;
    canvasRef.current.width = dims.width;
    canvasRef.current.height = dims.height;
  }, [dims]);

  // Render on time change (preview)
  useEffect(() => {
    if (!renderCfg) return;
    renderFrame(renderCfg, previewTime);
  }, [previewTime, renderCfg]);

  // Initial poster render
  useEffect(() => {
    if (renderCfg && !isPlaying) renderFrame(renderCfg, 0);
  }, [renderCfg, isPlaying]);

  // ---- Preview playback ----
  const stopPreview = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (previewSourceRef.current) {
      try {
        previewSourceRef.current.stop();
      } catch {}
      previewSourceRef.current = null;
    }
    if (previewCtxRef.current) {
      previewCtxRef.current.close().catch(() => {});
      previewCtxRef.current = null;
    }
    for (const m of media) if (m.kind === "video") m.el.pause();
    setIsPlaying(false);
  }, [media]);

  const playPreview = useCallback(async () => {
    if (!renderCfg || !audioBuffer) return;
    stopPreview();
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    previewCtxRef.current = ctx;
    // Trimmed song
    const startFrame = Math.floor(audioTrim[0] * audioBuffer.sampleRate);
    const endFrame = Math.floor(audioTrim[1] * audioBuffer.sampleRate);
    const len = endFrame - startFrame;
    const trimmed = ctx.createBuffer(audioBuffer.numberOfChannels, len, audioBuffer.sampleRate);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const dst = trimmed.getChannelData(c);
      const src = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) dst[i] = src[startFrame + i] ?? 0;
    }
    const src = ctx.createBufferSource();
    src.buffer = trimmed;
    const gain = ctx.createGain();
    gain.gain.value = audioVolume;
    const t0 = ctx.currentTime + 0.05;
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(audioVolume, t0 + fadeIn);
    }
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(audioVolume, t0 + durationSec - fadeOut);
      gain.gain.linearRampToValueAtTime(0, t0 + durationSec);
    }
    src.connect(gain).connect(ctx.destination);
    src.start(t0);
    previewSourceRef.current = src;

    // Schedule SFX for preview
    if (plan && renderCfg) {
      renderCfg.beats.forEach((b, i) => {
        const tr = plan.transitions[i];
        if (tr) scheduleSfx(ctx, ctx.destination, tr.sfx, t0 + b, tr.isHero ? 1 : 0.65);
      });
    }

    // Start videos
    for (const m of media) {
      if (m.kind === "video") {
        m.el.currentTime = 0;
        try {
          await m.el.play();
        } catch {}
      }
    }

    previewStartWallRef.current = performance.now();
    setIsPlaying(true);
    const tick = () => {
      const t = (performance.now() - previewStartWallRef.current) / 1000;
      if (t >= durationSec) {
        setPreviewTime(0);
        stopPreview();
        return;
      }
      setPreviewTime(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [renderCfg, audioBuffer, audioTrim, audioVolume, fadeIn, fadeOut, durationSec, plan, media, stopPreview]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  // ---- Export ----
  const doExport = useCallback(async () => {
    if (!renderCfg || !audioBuffer || !plan) return;
    stopPreview();
    setIsExporting(true);
    setExportProgress(0);
    toast.loading("Rendering your reel...", { id: "export" });
    try {
      const sfxSchedule = renderCfg.beats.map((b, i) => {
        const tr = plan.transitions[i];
        return { time: b, kind: tr?.sfx ?? "none", intensity: tr?.isHero ? 1 : 0.65 };
      });
      const blob = await exportVideo(
        renderCfg,
        audioBuffer,
        audioTrim[0],
        audioTrim[1],
        fadeIn,
        fadeOut,
        audioVolume,
        sfxSchedule,
        30,
        setExportProgress,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      a.href = url;
      a.download = `reelith-${occasion.toLowerCase()}-${Date.now()}.${ext}`;
      a.click();
      toast.success("Exported! Check your downloads.", { id: "export" });
    } catch (e) {
      toast.error("Export failed: " + (e as Error).message, { id: "export" });
    } finally {
      setIsExporting(false);
    }
  }, [renderCfg, audioBuffer, audioTrim, plan, fadeIn, fadeOut, audioVolume, occasion, stopPreview]);

  // ---- UI ----
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster theme="dark" position="top-right" />

      {/* Header */}
      <header className="border-b border-border/60 bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <Film className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight">Reelith</h1>
              <p className="text-xs text-muted-foreground">AI beat-synced reel editor</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground md:inline">
              Every transition on the beat.
            </span>
            <Heart className="h-4 w-4 text-accent" />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] gap-6 px-6 py-6 lg:grid-cols-[380px_1fr_360px]">
        {/* LEFT: Media */}
        <section className="space-y-4">
          <Panel title="Media Library" icon={<ImageIcon className="h-4 w-4" />}>
            <MediaDropzone onFiles={onMediaFiles} />
            {media.length > 0 && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {media.map((m, i) => (
                  <div key={m.url} className="group relative aspect-square overflow-hidden rounded-md border border-border/60 bg-black">
                    {m.kind === "image" ? (
                      <img src={m.url} className="h-full w-full object-cover" alt="" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-secondary">
                        <Video className="h-6 w-6 text-primary" />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[10px] text-white">
                      {i + 1}. {m.name}
                    </div>
                    <button
                      onClick={() => setMedia((p) => p.filter((_, idx) => idx !== i))}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/80 opacity-0 transition group-hover:opacity-100"
                    >
                      <X className="h-3 w-3 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              {media.length === 0 ? "Photos and short clips. Reorder by removing and re-adding." : `${media.length} clip${media.length > 1 ? "s" : ""}`}
            </p>
          </Panel>

          <Panel title="Occasion & Format" icon={<Crop className="h-4 w-4" />}>
            <label className="text-xs font-medium text-muted-foreground">Occasion</label>
            <Select value={occasion} onValueChange={setOccasion}>
              <SelectTrigger className="mt-1 bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OCCASIONS.map((o) => (
                  <SelectItem key={o} value={o}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="mt-3 block text-xs font-medium text-muted-foreground">Aspect ratio</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(Object.keys(ASPECT_RATIOS) as AspectKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setAspect(k)}
                  className={`rounded-md border px-2 py-2 text-xs transition ${
                    aspect === k
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  <div className="font-bold">{k}</div>
                  <div className="text-[10px] opacity-70">{ASPECT_RATIOS[k].label}</div>
                </button>
              ))}
            </div>
          </Panel>
        </section>

        {/* CENTER: Preview */}
        <section className="flex flex-col items-center">
          <div className="w-full rounded-xl border border-border/60 bg-card/40 p-4">
            <div className="flex items-center justify-between pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Preview</span>
                {plan && (
                  <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {plan.styleName}
                  </span>
                )}
              </div>
              <div className="text-xs tabular-nums text-muted-foreground">
                {previewTime.toFixed(1)}s / {durationSec.toFixed(1)}s
              </div>
            </div>
            <div className="flex justify-center rounded-lg bg-black p-4">
              <canvas
                ref={canvasRef}
                style={{
                  aspectRatio: `${dims.width}/${dims.height}`,
                  maxHeight: "70vh",
                  maxWidth: "100%",
                  background: "#000",
                }}
                className="rounded shadow-2xl"
              />
            </div>

            {/* Timeline scrubber */}
            {plan && beatAnalysis && (
              <div className="mt-3">
                <div className="relative h-2 rounded-full bg-secondary">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-primary"
                    style={{ width: `${(previewTime / durationSec) * 100}%` }}
                  />
                  {beatAnalysis.beats.map((b, i) => {
                    const rel = b - audioTrim[0];
                    if (rel < 0 || rel > durationSec) return null;
                    const hero = beatAnalysis.heroBeats.includes(b);
                    return (
                      <div
                        key={i}
                        className={`absolute top-1/2 -translate-y-1/2 rounded-full ${
                          hero ? "h-3 w-1 bg-accent" : "h-2 w-0.5 bg-primary/60"
                        }`}
                        style={{ left: `${(rel / durationSec) * 100}%` }}
                      />
                    );
                  })}
                </div>
                <input
                  type="range"
                  min={0}
                  max={durationSec}
                  step={0.05}
                  value={previewTime}
                  onChange={(e) => {
                    stopPreview();
                    setPreviewTime(parseFloat(e.target.value));
                  }}
                  className="mt-1 w-full accent-primary"
                />
              </div>
            )}

            {/* Controls */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <Button
                size="lg"
                onClick={isPlaying ? stopPreview : playPreview}
                disabled={!plan || !renderCfg}
                variant="secondary"
              >
                {isPlaying ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
                {isPlaying ? "Stop" : "Play"}
              </Button>
              <Button
                size="lg"
                onClick={runDirector}
                disabled={isDirecting || !audioBuffer || media.length < 2}
                className="bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90"
              >
                {isDirecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                {plan ? "Re-direct" : "AI Direct Edit"}
              </Button>
              <Button
                size="lg"
                onClick={doExport}
                disabled={!plan || isExporting}
                variant="outline"
                className="border-accent text-accent hover:bg-accent hover:text-accent-foreground"
              >
                {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Export {dims.width}×{dims.height}
              </Button>
            </div>

            {isExporting && (
              <div className="mt-3">
                <Progress value={exportProgress * 100} className="h-2" />
                <p className="mt-1 text-center text-xs text-muted-foreground">
                  Rendering in real-time — please keep this tab focused. {Math.round(exportProgress * 100)}%
                </p>
              </div>
            )}
          </div>

          {plan && (
            <div className="mt-4 w-full rounded-xl border border-border/60 bg-card/40 p-4">
              <div className="flex items-center gap-2 pb-2">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  AI Director's Notes
                </span>
              </div>
              <p className="text-sm">
                <span className="font-semibold text-primary">Style:</span> {plan.styleReference}
              </p>
              <p className="mt-1 text-sm">
                <span className="font-semibold text-primary">Pacing:</span> {plan.pacingNote}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {plan.transitions.slice(0, 20).map((t, i) => (
                  <span
                    key={i}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                      t.isHero
                        ? "bg-accent/20 text-accent"
                        : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {t.type}
                    {t.sfx !== "none" && <span className="ml-1 opacity-60">+{t.sfx}</span>}
                  </span>
                ))}
                {plan.transitions.length > 20 && (
                  <span className="text-[10px] text-muted-foreground">+{plan.transitions.length - 20} more</span>
                )}
              </div>
            </div>
          )}
        </section>

        {/* RIGHT: Audio */}
        <section className="space-y-4">
          <Panel title="Soundtrack" icon={<Music className="h-4 w-4" />}>
            {!audioFile ? (
              <AudioDropzone onFile={onAudioFile} />
            ) : (
              <div>
                <div className="flex items-center justify-between rounded-md bg-secondary px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{audioFile.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {audioBuffer?.duration.toFixed(1)}s • {audioBuffer?.numberOfChannels}ch
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setAudioFile(null);
                      setAudioBuffer(null);
                      setPlan(null);
                    }}
                    className="ml-2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {audioBuffer && (
                  <div className="mt-3">
                    <div className="relative h-16 rounded-md bg-secondary/60 overflow-hidden">
                      <canvas ref={waveformRef} className="absolute inset-0 h-full w-full" />
                      <div
                        className="absolute inset-y-0 border-l-2 border-r-2 border-primary bg-primary/10"
                        style={{
                          left: `${(audioTrim[0] / (audioBuffer.duration || 1)) * 100}%`,
                          right: `${100 - (audioTrim[1] / (audioBuffer.duration || 1)) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>Trim: {audioTrim[0].toFixed(1)}s → {audioTrim[1].toFixed(1)}s</span>
                        <span>{(audioTrim[1] - audioTrim[0]).toFixed(1)}s</span>
                      </div>
                      <Slider
                        value={audioTrim}
                        min={0}
                        max={audioBuffer.duration}
                        step={0.1}
                        onValueChange={(v) => {
                          const [a, b] = v as [number, number];
                          const clamped = Math.min(60, Math.max(3, b - a));
                          setAudioTrim([a, a + clamped]);
                          setPlan(null);
                        }}
                        className="mt-2"
                      />
                    </div>
                    <Button size="sm" variant="outline" onClick={autoPickBest} className="mt-3 w-full">
                      <Scissors className="mr-1.5 h-3.5 w-3.5" />
                      AI: Auto-pick best 30s
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {audioBuffer && (
            <Panel title="Audio Controls" icon={<Music className="h-4 w-4" />}>
              <SliderRow label="Volume" value={audioVolume} min={0} max={1} step={0.05} onChange={setAudioVolume} display={`${Math.round(audioVolume * 100)}%`} />
              <SliderRow label="Fade in" value={fadeIn} min={0} max={3} step={0.1} onChange={setFadeIn} display={`${fadeIn.toFixed(1)}s`} />
              <SliderRow label="Fade out" value={fadeOut} min={0} max={3} step={0.1} onChange={setFadeOut} display={`${fadeOut.toFixed(1)}s`} />
            </Panel>
          )}

          {beatAnalysis && (
            <Panel title="Beat Analysis" icon={<Sparkles className="h-4 w-4" />}>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat label="BPM" value={beatAnalysis.bpm} />
                <Stat label="Beats" value={beatAnalysis.beats.length} />
                <Stat label="Drops" value={beatAnalysis.heroBeats.length} />
              </div>
              <div className="mt-3 flex h-8 items-end gap-px">
                {beatAnalysis.energyCurve.map((v, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-t bg-primary/70"
                    style={{ height: `${Math.max(4, v * 100)}%` }}
                  />
                ))}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">Energy curve across the trimmed section</p>
            </Panel>
          )}
        </section>
      </main>

      <footer className="border-t border-border/60 py-6 text-center text-xs text-muted-foreground">
        Every transition lands on a beat. Made with obsession.
      </footer>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function MediaDropzone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files) onFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition ${
        drag ? "border-primary bg-primary/10" : "border-border bg-secondary/40 hover:border-primary/50"
      }`}
    >
      <Upload className="mb-2 h-6 w-6 text-primary" />
      <p className="text-xs font-medium">Drop photos or clips</p>
      <p className="text-[10px] text-muted-foreground">or click to browse</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => e.target.files && onFiles(e.target.files)}
      />
    </div>
  );
}

function AudioDropzone({ onFile }: { onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onClick={() => inputRef.current?.click()}
      className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-secondary/40 p-6 text-center transition hover:border-primary/50"
    >
      <Music className="mb-2 h-6 w-6 text-primary" />
      <p className="text-xs font-medium">Drop a song</p>
      <p className="text-[10px] text-muted-foreground">MP3, WAV, M4A</p>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  display: string;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-primary">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
        className="mt-1"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-secondary py-2">
      <div className="text-lg font-black text-primary">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}