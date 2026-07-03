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
  Plus,
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
  selectCutBeats,
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
import { generateEditPlan, type EditPlanT } from "@/lib/director.functions";

const OCCASIONS = ["Wedding", "Birthday", "Anniversary", "Party", "Baby Shower", "Graduation", "Travel"] as const;

const TRANSITION_TYPES = [
  "cut",
  "cross-dissolve",
  "blur-fade",
  "zoom-punch",
  "morph-zoom",
  "flash-white",
  "flash-black",
  "push-left",
  "push-right",
  "push-up",
  "light-leak",
  "film-burn",
  "glitch",
] as const;

type TransitionType = (typeof TRANSITION_TYPES)[number];

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
  const [cutTimesAbs, setCutTimesAbs] = useState<number[]>([]); // absolute (in original buffer)
  const [plan, setPlan] = useState<EditPlanT | null>(null);
  const [isDirecting, setIsDirecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const timelineWaveRef = useRef<HTMLCanvasElement>(null);
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
      setCutTimesAbs([]);
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
    setCutTimesAbs([]);
    toast.success(`Auto-picked best ${(end - start).toFixed(0)}s`);
  }, [audioBuffer]);

  // ---- Waveform draw for trim panel ----
  useEffect(() => {
    if (!audioBuffer || !waveformRef.current) return;
    const c = waveformRef.current;
    c.width = c.clientWidth * devicePixelRatio;
    c.height = c.clientHeight * devicePixelRatio;
    drawWaveform(c, audioBuffer, { color: "rgba(245,158,11,0.65)" });
  }, [audioBuffer]);

  // ---- Timeline waveform (trimmed section) ----
  useEffect(() => {
    if (!audioBuffer || !timelineWaveRef.current) return;
    const c = timelineWaveRef.current;
    c.width = c.clientWidth * devicePixelRatio;
    c.height = c.clientHeight * devicePixelRatio;
    drawWaveform(c, audioBuffer, {
      color: "rgba(148,163,184,0.55)",
      startSec: audioTrim[0],
      endSec: audioTrim[1],
    });
  }, [audioBuffer, audioTrim]);

  // ---- Analyze beats and pick sparse cuts ----
  const analyze = useCallback(() => {
    if (!audioBuffer) return null;
    const analysis = analyzeBeats(audioBuffer, audioTrim[0], audioTrim[1]);
    setBeatAnalysis(analysis);
    const cuts = selectCutBeats(analysis, audioTrim[0], audioTrim[1], {
      minGapSec: 1.1,
      targetSecPerCut: Math.max(1.4, durationSec / Math.max(3, media.length)),
    });
    setCutTimesAbs(cuts);
    return { analysis, cuts };
  }, [audioBuffer, audioTrim, durationSec, media.length]);

  // ---- AI Director ----
  const runDirector = useCallback(async () => {
    if (!audioBuffer || media.length < 2) {
      toast.error("Add at least 2 photos/videos and a song first");
      return;
    }
    setIsDirecting(true);
    toast.loading("Feeling the song + directing your edit...", { id: "director" });
    try {
      const analysis = analyzeBeats(audioBuffer, audioTrim[0], audioTrim[1]);
      setBeatAnalysis(analysis);
      const cuts = selectCutBeats(analysis, audioTrim[0], audioTrim[1], {
        minGapSec: 1.1,
        targetSecPerCut: Math.max(1.4, durationSec / Math.max(3, media.length)),
      });
      setCutTimesAbs(cuts);

      const relHero = analysis.heroBeats
        .map((b) => b - audioTrim[0])
        .filter((b) => b > 0 && b < durationSec);
      const cutBeatTimes = cuts.map((c) => c - audioTrim[0]);
      const cutBeatEnergies = cutBeatTimes.map((rb) => {
        const idx = Math.floor((rb / durationSec) * analysis.energyCurve.length);
        return analysis.energyCurve[Math.max(0, Math.min(analysis.energyCurve.length - 1, idx))] ?? 0.5;
      });

      const result = await directorFn({
        data: {
          occasion,
          aspectRatio: aspect,
          mediaCount: media.length,
          audio: {
            durationSec,
            bpm: analysis.bpm,
            beatCount: analysis.beats.length,
            energyCurve: analysis.energyCurve,
            heroBeatTimes: relHero,
            startSec: audioTrim[0],
            endSec: audioTrim[1],
            brightnessCurve: analysis.brightnessCurve,
            dynamicRange: analysis.dynamicRange,
            tempoStability: analysis.tempoStability,
            quietRatio: analysis.quietRatio,
            peakDensity: analysis.peakDensity,
            fingerprint: analysis.fingerprint,
            cutBeatEnergies,
            cutBeatTimes,
          },
        },
      });
      setPlan(result);
      toast.success(`AI directed: "${result.styleName}" — ${cuts.length} cuts`, { id: "director" });
    } catch (e) {
      toast.error("Director failed: " + (e as Error).message, { id: "director" });
    } finally {
      setIsDirecting(false);
    }
  }, [audioBuffer, media.length, audioTrim, occasion, aspect, durationSec, directorFn]);

  // ---- Timeline editing: add/remove cut points, change transitions ----
  const toggleCutAtBeat = useCallback(
    (beatAbs: number) => {
      setCutTimesAbs((prev) => {
        const exists = prev.some((c) => Math.abs(c - beatAbs) < 0.01);
        const next = exists ? prev.filter((c) => Math.abs(c - beatAbs) >= 0.01) : [...prev, beatAbs].sort((a, b) => a - b);
        // Sync plan transitions length
        setPlan((p) => {
          if (!p) return p;
          const target = next.length;
          const current = p.transitions.slice(0, target);
          while (current.length < target) current.push({ type: "cross-dissolve", isHero: false });
          return { ...p, transitions: current };
        });
        return next;
      });
    },
    [],
  );

  const changeTransition = useCallback((i: number, patch: Partial<EditPlanT["transitions"][number]>) => {
    setPlan((p) => {
      if (!p) return p;
      return {
        ...p,
        transitions: p.transitions.map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
      };
    });
  }, []);

  // ---- Build render config ----
  const relCuts = useMemo(
    () =>
      cutTimesAbs
        .map((c) => c - audioTrim[0])
        .filter((c) => c > 0.05 && c < durationSec - 0.05)
        .sort((a, b) => a - b),
    [cutTimesAbs, audioTrim, durationSec],
  );

  const renderCfg = useMemo(() => {
    if (!canvasRef.current || !plan || media.length === 0) return null;
    return {
      canvas: canvasRef.current,
      width: dims.width,
      height: dims.height,
      media,
      cutTimes: relCuts,
      plan,
      audioStartSec: audioTrim[0],
      totalDurationSec: durationSec,
      captionHook: plan.captionHook,
      captionOutro: plan.captionOutro,
    };
  }, [plan, media, dims, audioTrim, durationSec, relCuts]);

  useEffect(() => {
    if (!canvasRef.current) return;
    canvasRef.current.width = dims.width;
    canvasRef.current.height = dims.height;
  }, [dims]);

  useEffect(() => {
    if (!renderCfg) return;
    renderFrame(renderCfg, previewTime);
  }, [previewTime, renderCfg]);

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
  }, [renderCfg, audioBuffer, audioTrim, audioVolume, fadeIn, fadeOut, durationSec, media, stopPreview]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  // ---- Export ----
  const doExport = useCallback(async () => {
    if (!renderCfg || !audioBuffer || !plan) return;
    stopPreview();
    setIsExporting(true);
    setExportProgress(0);
    toast.loading("Rendering your reel...", { id: "export" });
    try {
      const blob = await exportVideo(
        renderCfg,
        audioBuffer,
        audioTrim[0],
        audioTrim[1],
        fadeIn,
        fadeOut,
        audioVolume,
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

      <header className="border-b border-border/60 bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <Film className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-base font-black tracking-tight">Reelith Studio</h1>
              <p className="text-[10px] text-muted-foreground">AI-directed reel editor · timeline mode</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Heart className="h-3.5 w-3.5 text-accent" />
            <span className="hidden md:inline">Sparse cuts. No sound effects. Pure edit.</span>
          </div>
        </div>
      </header>

      {/* Top workspace: sidebars + preview */}
      <main className="mx-auto grid max-w-[1800px] gap-4 px-4 py-4 lg:grid-cols-[320px_1fr_320px]">
        {/* LEFT sidebar */}
        <section className="space-y-3">
          <Panel title="Media" icon={<ImageIcon className="h-4 w-4" />}>
            <MediaDropzone onFiles={onMediaFiles} />
            {media.length > 0 && (
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {media.map((m, i) => (
                  <div key={m.url} className="group relative aspect-square overflow-hidden rounded-md border border-border/60 bg-black">
                    {m.kind === "image" ? (
                      <img src={m.url} className="h-full w-full object-cover" alt="" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-secondary">
                        <Video className="h-5 w-5 text-primary" />
                      </div>
                    )}
                    <div className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] font-bold text-white">{i + 1}</div>
                    <button
                      onClick={() => setMedia((p) => p.filter((_, idx) => idx !== i))}
                      className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/80 opacity-0 transition group-hover:opacity-100"
                    >
                      <X className="h-2.5 w-2.5 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Occasion & Format" icon={<Crop className="h-4 w-4" />}>
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Occasion</label>
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
            <label className="mt-3 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Aspect ratio</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {(Object.keys(ASPECT_RATIOS) as AspectKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setAspect(k)}
                  className={`rounded-md border px-2 py-1.5 text-xs transition ${
                    aspect === k
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-secondary text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  <div className="font-bold">{k}</div>
                  <div className="text-[9px] opacity-70">{ASPECT_RATIOS[k].label}</div>
                </button>
              ))}
            </div>
          </Panel>
        </section>

        {/* CENTER: preview */}
        <section className="flex flex-col">
          <div className="rounded-xl border border-border/60 bg-card/40 p-4">
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
            <div className="flex justify-center rounded-lg bg-black p-3">
              <canvas
                ref={canvasRef}
                style={{
                  aspectRatio: `${dims.width}/${dims.height}`,
                  maxHeight: "52vh",
                  maxWidth: "100%",
                  background: "#000",
                }}
                className="rounded shadow-2xl"
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={isPlaying ? stopPreview : playPreview} disabled={!plan || !renderCfg} variant="secondary">
                {isPlaying ? <Pause className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                {isPlaying ? "Stop" : "Play"}
              </Button>
              <Button
                size="sm"
                onClick={runDirector}
                disabled={isDirecting || !audioBuffer || media.length < 2}
                className="bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90"
              >
                {isDirecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1.5 h-3.5 w-3.5" />}
                {plan ? "Re-direct" : "AI Direct Edit"}
              </Button>
              <Button size="sm" onClick={doExport} disabled={!plan || isExporting} variant="outline" className="border-accent text-accent hover:bg-accent hover:text-accent-foreground">
                {isExporting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                Export {dims.width}×{dims.height}
              </Button>
            </div>

            {isExporting && (
              <div className="mt-3">
                <Progress value={exportProgress * 100} className="h-1.5" />
                <p className="mt-1 text-center text-[10px] text-muted-foreground">
                  Rendering in real-time — keep this tab focused. {Math.round(exportProgress * 100)}%
                </p>
              </div>
            )}
          </div>

          {plan && (
            <div className="mt-3 rounded-xl border border-border/60 bg-card/40 p-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-3 w-3 text-primary" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Director notes</span>
              </div>
              <p className="mt-1.5 text-xs"><span className="font-semibold text-primary">Style:</span> {plan.styleReference}</p>
              <p className="mt-1 text-xs"><span className="font-semibold text-primary">Pacing:</span> {plan.pacingNote}</p>
            </div>
          )}
        </section>

        {/* RIGHT sidebar */}
        <section className="space-y-3">
          <Panel title="Soundtrack" icon={<Music className="h-4 w-4" />}>
            {!audioFile ? (
              <AudioDropzone onFile={onAudioFile} />
            ) : (
              <div>
                <div className="flex items-center justify-between rounded-md bg-secondary px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{audioFile.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {audioBuffer?.duration.toFixed(1)}s · {audioBuffer?.numberOfChannels}ch
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setAudioFile(null);
                      setAudioBuffer(null);
                      setPlan(null);
                      setCutTimesAbs([]);
                    }}
                    className="ml-2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {audioBuffer && (
                  <div className="mt-3">
                    <div className="relative h-14 overflow-hidden rounded-md bg-secondary/60">
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
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{audioTrim[0].toFixed(1)}s → {audioTrim[1].toFixed(1)}s</span>
                        <span>{durationSec.toFixed(1)}s</span>
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
                          setCutTimesAbs([]);
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
            <Panel title="Audio" icon={<Music className="h-4 w-4" />}>
              <SliderRow label="Volume" value={audioVolume} min={0} max={1} step={0.05} onChange={setAudioVolume} display={`${Math.round(audioVolume * 100)}%`} />
              <SliderRow label="Fade in" value={fadeIn} min={0} max={3} step={0.1} onChange={setFadeIn} display={`${fadeIn.toFixed(1)}s`} />
              <SliderRow label="Fade out" value={fadeOut} min={0} max={3} step={0.1} onChange={setFadeOut} display={`${fadeOut.toFixed(1)}s`} />
            </Panel>
          )}

          {beatAnalysis && (
            <Panel title="Beat Analysis" icon={<Sparkles className="h-4 w-4" />}>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat label="BPM" value={beatAnalysis.bpm} />
                <Stat label="Cuts" value={relCuts.length} />
                <Stat label="Drops" value={beatAnalysis.heroBeats.length} />
              </div>
            </Panel>
          )}
        </section>
      </main>

      {/* Bottom TIMELINE editor — Descript-style */}
      <div className="mx-auto max-w-[1800px] px-4 pb-8">
        <Timeline
          durationSec={durationSec}
          beats={beatAnalysis?.beats.map((b) => b - audioTrim[0]).filter((b) => b > 0 && b < durationSec) ?? []}
          heroBeats={beatAnalysis?.heroBeats.map((b) => b - audioTrim[0]).filter((b) => b > 0 && b < durationSec) ?? []}
          cutTimes={relCuts}
          absCutTimes={cutTimesAbs}
          audioStart={audioTrim[0]}
          media={media}
          plan={plan}
          previewTime={previewTime}
          waveformRef={timelineWaveRef}
          hasAudio={!!audioBuffer}
          onScrub={(t) => {
            stopPreview();
            setPreviewTime(Math.max(0, Math.min(durationSec, t)));
          }}
          onToggleBeat={(beatRel) => {
            const abs = beatRel + audioTrim[0];
            toggleCutAtBeat(abs);
          }}
          onChangeTransition={changeTransition}
          onAnalyze={analyze}
        />
      </div>

      <footer className="border-t border-border/60 py-4 text-center text-[10px] text-muted-foreground">
        Click a beat marker to toggle it as a cut · click a clip to change its transition · no external SFX
      </footer>
    </div>
  );
}

// ============================================================================
// TIMELINE EDITOR
// ============================================================================
function Timeline({
  durationSec,
  beats,
  heroBeats,
  cutTimes,
  absCutTimes,
  audioStart,
  media,
  plan,
  previewTime,
  waveformRef,
  hasAudio,
  onScrub,
  onToggleBeat,
  onChangeTransition,
  onAnalyze,
}: {
  durationSec: number;
  beats: number[];
  heroBeats: number[];
  cutTimes: number[];
  absCutTimes: number[];
  audioStart: number;
  media: MediaItem[];
  plan: EditPlanT | null;
  previewTime: number;
  waveformRef: React.RefObject<HTMLCanvasElement | null>;
  hasAudio: boolean;
  onScrub: (t: number) => void;
  onToggleBeat: (beatRel: number) => void;
  onChangeTransition: (i: number, patch: Partial<EditPlanT["transitions"][number]>) => void;
  onAnalyze: () => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  if (durationSec <= 0.1) {
    return (
      <div className="rounded-xl border border-dashed border-border/60 bg-card/20 p-8 text-center">
        <p className="text-sm text-muted-foreground">Upload a song to unlock the timeline editor.</p>
      </div>
    );
  }

  // Build clip segments — [0, cut1, cut2, ..., duration]
  const bounds = [0, ...cutTimes, durationSec];
  const segments: Array<{ start: number; end: number; media: MediaItem | undefined; index: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    segments.push({ start: bounds[i], end: bounds[i + 1], media: media[i % Math.max(1, media.length)], index: i });
  }

  // Timeline seconds -> percent
  const pct = (t: number) => (t / durationSec) * 100;

  // Tick marks every 1s
  const seconds = Math.ceil(durationSec);
  const ticks: number[] = [];
  for (let s = 0; s <= seconds; s++) ticks.push(s);

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 shadow-xl">
      {/* toolbar */}
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Timeline</div>
          <span className="rounded bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {previewTime.toFixed(2)}s / {durationSec.toFixed(1)}s
          </span>
          <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            {cutTimes.length} cut{cutTimes.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {beats.length === 0 && hasAudio && (
            <button
              onClick={onAnalyze}
              className="rounded bg-primary/10 px-2 py-1 text-primary hover:bg-primary/20"
            >
              <Sparkles className="mr-1 inline h-3 w-3" />
              Analyze beats
            </button>
          )}
          <span className="hidden md:inline">Click beat = toggle cut · Click clip = change transition</span>
        </div>
      </div>

      {/* Ruler */}
      <div className="relative h-5 border-b border-border/40 px-3">
        {ticks.map((s) => (
          <div key={s} className="absolute top-0 flex h-full flex-col items-start" style={{ left: `calc(${pct(s)}% + 12px - 12px)` }}>
            <div className="h-2 w-px bg-border" />
            <span className="ml-0.5 mt-0.5 text-[9px] tabular-nums text-muted-foreground">{s}s</span>
          </div>
        ))}
      </div>

      {/* Clip strip */}
      <div className="relative px-3 pt-3">
        <div ref={stripRef} className="relative h-16 overflow-hidden rounded-md border border-border/60 bg-black">
          {segments.map((seg) => {
            const w = pct(seg.end - seg.start);
            const left = pct(seg.start);
            const m = seg.media;
            const tr = plan?.transitions[seg.index - 1];
            return (
              <button
                key={seg.index}
                type="button"
                onClick={() => setEditingIdx(seg.index === 0 ? null : seg.index - 1)}
                className={`group absolute top-0 h-full overflow-hidden border-r-2 border-primary/70 text-left transition ${
                  editingIdx === seg.index - 1 ? "ring-2 ring-inset ring-accent" : ""
                }`}
                style={{ left: `${left}%`, width: `${w}%` }}
                title={seg.index === 0 ? "Opening clip" : `Cut ${seg.index}: ${tr?.type ?? ""}`}
              >
                {m?.kind === "image" ? (
                  <img src={m.url} alt="" className="h-full w-full object-cover opacity-90" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-secondary">
                    <Video className="h-4 w-4 text-primary" />
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1 pb-0.5 pt-4 text-[9px] font-medium text-white">
                  {seg.index === 0 ? "opener" : tr?.type ?? "—"}
                  {tr?.isHero && <span className="ml-1 text-accent">★</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Beat markers row */}
      <div className="relative mx-3 mt-2 h-7 rounded-md bg-background/40">
        {beats.map((b, i) => {
          const isCut = absCutTimes.some((c) => Math.abs(c - audioStart - b) < 0.02);
          const isHero = heroBeats.some((h) => Math.abs(h - b) < 0.02);
          return (
            <button
              key={i}
              onClick={() => onToggleBeat(b)}
              className="group absolute top-0 flex h-full w-3 -translate-x-1/2 items-center justify-center"
              style={{ left: `${pct(b)}%` }}
              title={`${b.toFixed(2)}s ${isHero ? "· hero" : ""} — ${isCut ? "click to remove cut" : "click to add cut"}`}
            >
              <div
                className={`w-0.5 transition-all ${
                  isCut
                    ? isHero
                      ? "h-full bg-accent"
                      : "h-full bg-primary"
                    : isHero
                      ? "h-3 bg-accent/40 group-hover:bg-accent"
                      : "h-2 bg-muted-foreground/40 group-hover:bg-primary"
                }`}
              />
              {isCut && (
                <div
                  className={`pointer-events-none absolute -top-1 h-1.5 w-1.5 rounded-full ${
                    isHero ? "bg-accent" : "bg-primary"
                  }`}
                />
              )}
            </button>
          );
        })}
        {beats.length === 0 && (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
            {hasAudio ? "Run analyze to see beats" : "Upload a song to see beats"}
          </div>
        )}
      </div>

      {/* Waveform + playhead + scrub */}
      <div
        className="relative mx-3 my-2 h-14 cursor-pointer overflow-hidden rounded-md bg-background/40"
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const t = ((e.clientX - rect.left) / rect.width) * durationSec;
          onScrub(t);
        }}
      >
        <canvas ref={waveformRef} className="absolute inset-0 h-full w-full" />
        {/* cut lines */}
        {cutTimes.map((c, i) => (
          <div key={i} className="absolute inset-y-0 w-px bg-primary/70" style={{ left: `${pct(c)}%` }} />
        ))}
        {/* playhead */}
        <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: `${pct(previewTime)}%` }}>
          <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-accent" />
        </div>
      </div>

      {/* Transition inspector for selected clip */}
      {plan && editingIdx !== null && plan.transitions[editingIdx] && (
        <div className="mx-3 mb-3 rounded-md border border-accent/40 bg-accent/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase tracking-wider text-accent">
              Cut #{editingIdx + 1} at {cutTimes[editingIdx]?.toFixed(2)}s
            </div>
            <button onClick={() => setEditingIdx(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Transition</label>
              <div className="mt-1 flex flex-wrap gap-1">
                {TRANSITION_TYPES.map((tt) => (
                  <button
                    key={tt}
                    onClick={() => onChangeTransition(editingIdx, { type: tt })}
                    className={`rounded border px-2 py-1 text-[10px] font-medium transition ${
                      plan.transitions[editingIdx].type === tt
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-secondary text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    {tt}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => onChangeTransition(editingIdx, { isHero: !plan.transitions[editingIdx].isHero })}
              className={`h-8 rounded-md border px-3 text-xs font-bold transition ${
                plan.transitions[editingIdx].isHero
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border bg-secondary text-muted-foreground hover:border-accent"
              }`}
              title="Mark this as a hero beat (adds subtle pulse)"
            >
              ★ Hero
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Small building blocks
// ============================================================================
function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{title}</h3>
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
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files) onFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 text-center transition ${
        drag ? "border-primary bg-primary/10" : "border-border bg-secondary/40 hover:border-primary/50"
      }`}
    >
      <Upload className="mb-1.5 h-5 w-5 text-primary" />
      <p className="text-[11px] font-medium">Drop photos or clips</p>
      <p className="text-[9px] text-muted-foreground">or click to browse</p>
      <input ref={inputRef} type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => e.target.files && onFiles(e.target.files)} />
    </div>
  );
}

function AudioDropzone({ onFile }: { onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onClick={() => inputRef.current?.click()}
      className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-secondary/40 p-4 text-center transition hover:border-primary/50"
    >
      <Music className="mb-1.5 h-5 w-5 text-primary" />
      <p className="text-[11px] font-medium">Drop a song</p>
      <p className="text-[9px] text-muted-foreground">MP3, WAV, M4A</p>
      <input ref={inputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

function SliderRow({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; display: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center justify-between text-[10px]">
        <span className="uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="font-mono text-primary">{display}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} className="mt-1" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-secondary py-1.5">
      <div className="text-base font-black text-primary">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}