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
  }),
});

const EditPlan = z.object({
  styleName: z.string(),
  styleReference: z.string(),
  pacingNote: z.string(),
  colorGrade: z.enum(["warm-romantic", "vibrant-party", "cinematic-teal", "golden-hour", "vintage-film"]),
  transitions: z.array(
    z.object({
      type: z.enum(["whip-pan", "zoom-punch", "flash-cut", "cross-dissolve", "glitch", "spin", "blur-fade", "cut"]),
      isHero: z.boolean(),
      sfx: z.enum(["whoosh", "impact", "riser", "none"]),
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
    const prompt = `You are an award-winning music video and reels editor. Analyze this song fingerprint and design a professional edit plan.

OCCASION: ${data.occasion}
ASPECT RATIO: ${data.aspectRatio}
MEDIA CLIPS AVAILABLE: ${data.mediaCount}

SONG ANALYSIS:
- Duration (trimmed section): ${(data.audio.endSec - data.audio.startSec).toFixed(1)}s
- Detected BPM: ${data.audio.bpm}
- Total beats in section: ${data.audio.beatCount}
- Energy curve (low->high, 0-1): [${data.audio.energyCurve.map((n) => n.toFixed(2)).join(", ")}]
- Hero beats (drops/peaks) at seconds: [${data.audio.heroBeatTimes.map((n) => n.toFixed(2)).join(", ")}]

Research how top editors (Peter McKinnon, Sam Kolder, cinematic wedding films, Instagram reels editors) would cut to a song of this tempo/energy for a ${data.occasion}. Choose a coherent style.

Design exactly ${transitionCount} transitions — one for each beat in order. Hero beats (drops) MUST get "zoom-punch", "whip-pan", "glitch", or "flash-cut" with "impact" or "riser" sfx. Calm beats get "cross-dissolve", "blur-fade", or "cut" with "whoosh" or "none". Match transition intensity to the local energy value.

Keep captionHook under 30 chars, captionOutro under 25 chars. Be bold and cinematic, not generic.`;

    try {
      const { output } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        output: Output.object({ schema: EditPlan }),
        prompt,
      });

      const plan = output as EditPlanT;
      while (plan.transitions.length < transitionCount) {
        plan.transitions.push({ type: "cut", isHero: false, sfx: "none" });
      }
      plan.transitions = plan.transitions.slice(0, transitionCount);
      return plan;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        // Fallback plan
        return fallbackPlan(data.occasion, transitionCount, data.audio.heroBeatTimes, data.audio.energyCurve);
      }
      throw err;
    }
  });

function fallbackPlan(
  occasion: string,
  count: number,
  heroTimes: number[],
  energy: number[],
): EditPlanT {
  const heroSet = new Set(heroTimes.map((t) => Math.round(t * 10)));
  const transitions: EditPlanT["transitions"] = Array.from({ length: count }, (_, i) => {
    const e = energy[Math.floor((i / count) * energy.length)] ?? 0.5;
    const isHero = i > 0 && i % 4 === 0;
    if (isHero || e > 0.7) {
      return { type: "zoom-punch" as const, isHero: true, sfx: "impact" as const };
    }
    if (e > 0.5) return { type: "whip-pan" as const, isHero: false, sfx: "whoosh" as const };
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