import { createServerFn } from "@tanstack/react-start";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const DirectorInput = z.object({
  occasion: z.string(),
  aspectRatio: z.string(),
  mediaCount: z.number(),
  audio: z.object({
    durationSec: z.number(),
    bpm: z.number(),
    beatCount: z.number(),
    energyCurve: z.array(z.number()).max(64),
    heroBeatTimes: z.array(z.number()).max(16),
    startSec: z.number(),
    endSec: z.number(),
    brightnessCurve: z.array(z.number()).max(64),
    dynamicRange: z.number(),
    tempoStability: z.number(),
    quietRatio: z.number(),
    peakDensity: z.number(),
    fingerprint: z.string(),
    beatEnergies: z.array(z.number()).max(128),
  }),
});

const EditPlan = z.object({
  styleName: z.string(),
  styleReference: z.string(),
  pacingNote: z.string(),
  colorGrade: z.enum(["warm-romantic", "vibrant-party", "cinematic-teal", "golden-hour", "vintage-film"]),
  transitions: z.array(
    z.object({
      type: z.enum(["zoom-punch", "flash-cut", "cross-dissolve", "glitch", "spin", "blur-fade", "cut"]),
      isHero: z.boolean(),
      sfx: z.enum(["impact", "riser", "whoosh", "none"]),
    }),
  ),
  motionStyle: z.enum(["ken-burns-slow", "ken-burns-fast", "punch-zoom", "parallax-drift"]),
  captionHook: z.string(),
  captionOutro: z.string(),
});

export type EditPlanT = z.infer<typeof EditPlan>;

export const generateEditPlan = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => DirectorInput.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const gateway = createLovableAiGatewayProvider(key);

    const transitionCount = Math.max(2, data.audio.beatCount);
    const a = data.audio;
    const feel = describeFeel(a);
    const prompt = `You are a world-class music video editor. Every song has a soul — you FEEL it, then cut to it. No two songs get the same edit.

SONG FINGERPRINT (unique to THIS section): ${a.fingerprint}
OCCASION: ${data.occasion} | ASPECT: ${data.aspectRatio} | CLIPS: ${data.mediaCount}

DEEP SONG ANALYSIS:
- Section length: ${(a.endSec - a.startSec).toFixed(1)}s at ${a.bpm} BPM (${a.peakDensity.toFixed(2)} beats/sec)
- Dynamic range: ${(a.dynamicRange * 100).toFixed(0)}% (${a.dynamicRange > 0.5 ? "huge swings — build/drop structure" : "flat energy — steady groove"})
- Tempo stability: ${(a.tempoStability * 100).toFixed(0)}% (${a.tempoStability > 0.7 ? "locked metronomic" : "loose, human-feel"})
- Brightness: ${(avg(a.brightnessCurve) * 100).toFixed(0)}% (${avg(a.brightnessCurve) > 0.5 ? "bright/airy — hi-hats, cymbals, synths" : "dark/warm — bass-driven, mellow"})
- Quiet ratio: ${(a.quietRatio * 100).toFixed(0)}% of the section is soft
- Energy curve (32 slices, 0-1): [${a.energyCurve.map((n) => n.toFixed(2)).join(",")}]
- Brightness curve: [${a.brightnessCurve.map((n) => n.toFixed(2)).join(",")}]
- Per-beat energies (${a.beatEnergies.length}): [${a.beatEnergies.map((n) => n.toFixed(2)).join(",")}]
- Hero drops at: [${a.heroBeatTimes.map((n) => n.toFixed(2) + "s").join(", ")}]

SONG FEEL (your read): ${feel}

YOUR JOB — think like a specific editor for THIS song:
1. Name a real editing style that fits this exact fingerprint (not generic "cinematic cut"). Reference a real aesthetic — Kolder travel drift, Daniels x Turnstile chaos-cut, Emmanuel Lubezki floating dreamscape, K-pop hard-cut, Bollywood wedding montage, A24 handheld, MTV early-2000s, whatever the song demands.
2. Pick colorGrade + motionStyle that MATCH the brightness and dynamic range (warm/dark songs -> warm-romantic or vintage-film + parallax-drift; bright/punchy -> cinematic-teal or vibrant-party + punch-zoom; ballads -> golden-hour + ken-burns-slow).
3. Design exactly ${transitionCount} transitions — one per beat, IN ORDER matching the per-beat energies array:
   - Beat energy > 0.75 or hero drop: "zoom-punch" / "glitch" / "flash-cut" + "impact" or "riser"
   - Beat energy 0.4-0.75: "spin" / "cross-dissolve" (with motion) / "blur-fade"
   - Beat energy < 0.4 (quiet): "cross-dissolve" / "cut" / "blur-fade" + "none" or soft "whoosh"
   - VARY types — never repeat the same transition more than 3 in a row. Reflect the song's shape: intros breathe, verses groove, choruses hit, bridges reset.
4. captionHook (<=30 chars) and captionOutro (<=25 chars) that echo the song's mood + occasion — never a generic "WEDDING" or heart emoji unless the song is that literal.

Make this plan DIFFERENT from what you'd give any other song. Use the fingerprint as commitment: two songs with different fingerprints must get different styleName, colorGrade, motionStyle, and transition patterns.`;

    try {
      const { output } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        output: Output.object({ schema: EditPlan }),
        prompt,
        temperature: 0.9,
      });

      const plan = output as EditPlanT;
      while (plan.transitions.length < transitionCount) {
        plan.transitions.push({ type: "cut", isHero: false, sfx: "none" });
      }
      plan.transitions = plan.transitions.slice(0, transitionCount);
      return plan;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        return fallbackPlan(data.occasion, transitionCount, data.audio.heroBeatTimes, data.audio.energyCurve);
      }
      throw err;
    }
  });

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function describeFeel(a: {
  bpm: number;
  dynamicRange: number;
  tempoStability: number;
  quietRatio: number;
  brightnessCurve: number[];
}): string {
  const parts: string[] = [];
  if (a.bpm < 80) parts.push("slow and intimate");
  else if (a.bpm < 110) parts.push("mid-tempo groove");
  else if (a.bpm < 140) parts.push("upbeat driving");
  else parts.push("high-energy fast");
  if (a.dynamicRange > 0.55) parts.push("with big drops and dynamics");
  else if (a.dynamicRange < 0.2) parts.push("with flat, hypnotic energy");
  if (avg(a.brightnessCurve) > 0.6) parts.push("bright and airy");
  else if (avg(a.brightnessCurve) < 0.35) parts.push("dark and bass-heavy");
  if (a.quietRatio > 0.4) parts.push("with breathing room in the mix");
  return parts.join(", ");
}

function fallbackPlan(
  occasion: string,
  count: number,
  heroTimes: number[],
  energy: number[],
): EditPlanT {
  const transitions: EditPlanT["transitions"] = Array.from({ length: count }, (_, i) => {
    const e = energy[Math.floor((i / count) * energy.length)] ?? 0.5;
    const isHero = i > 0 && i % 4 === 0;
    if (isHero || e > 0.7) {
      return { type: "zoom-punch" as const, isHero: true, sfx: "impact" as const };
    }
    if (e > 0.5) return { type: "spin" as const, isHero: false, sfx: "whoosh" as const };
    return { type: "cross-dissolve" as const, isHero: false, sfx: "none" as const };
  });
  return {
    styleName: `${occasion} Cinematic Cut`,
    styleReference: "Fast-paced cinematic reel with beat-synced transitions",
    pacingNote: "Build energy toward drops, breathe on softer moments",
    colorGrade: occasion.toLowerCase().includes("wedding") ? "warm-romantic" : "vibrant-party",
    transitions,
    motionStyle: "ken-burns-fast",
    captionHook: occasion.toUpperCase(),
    captionOutro: "❤",
  };
}