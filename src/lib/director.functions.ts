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
    cutBeatEnergies: z.array(z.number()).max(64),
    cutBeatTimes: z.array(z.number()).max(64),
  }),
  userPrompt: z.string().optional(),
  previousPlan: z
    .object({
      styleName: z.string(),
      colorGrade: z.string(),
      motionStyle: z.string(),
      transitions: z.array(z.object({ type: z.string(), isHero: z.boolean() })),
    })
    .optional(),
  mediaKinds: z.array(z.enum(["image", "video"])).optional(),
});

const EditPlan = z.object({
  styleName: z.string(),
  styleReference: z.string(),
  pacingNote: z.string(),
  colorGrade: z.enum(["warm-romantic", "vibrant-party", "cinematic-teal", "golden-hour", "vintage-film"]),
  transitions: z.array(
    z.object({
      type: z.enum([
        "cut",
        "cross-dissolve",
        "blur-fade",
        "zoom-punch",
        "flash-white",
        "flash-black",
        "push-left",
        "push-right",
        "push-up",
        "morph-zoom",
        "light-leak",
        "film-burn",
        "glitch",
      ]),
      isHero: z.boolean(),
    }),
  ),
  motionStyle: z.enum(["ken-burns-slow", "ken-burns-fast", "punch-zoom", "parallax-drift"]),
  captionHook: z.string().optional().default(""),
  captionOutro: z.string().optional().default(""),
});

export type EditPlanT = z.infer<typeof EditPlan>;

export const generateEditPlan = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => DirectorInput.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const gateway = createLovableAiGatewayProvider(key);

    const transitionCount = Math.max(1, data.audio.cutBeatEnergies.length);
    const a = data.audio;
    const feel = describeFeel(a);
    const userInstruction = (data.userPrompt ?? "").trim();
    const prev = data.previousPlan;
    const mediaKinds = data.mediaKinds ?? [];
    const videoCount = mediaKinds.filter((k) => k === "video").length;
    const prompt = `You are a world-class music video editor cutting a ${data.occasion} reel. Every song has a soul — FEEL it, then cut to it. Every cut must land ON a beat. Cuts should be MUSICAL and DENSE on high-energy sections (drops, choruses), and BREATHE on soft sections.

SONG FINGERPRINT (unique to THIS section): ${a.fingerprint}
OCCASION: ${data.occasion} | ASPECT: ${data.aspectRatio} | CLIPS: ${data.mediaCount} (${videoCount} video, ${data.mediaCount - videoCount} photo)
CLIP ORDER (1-indexed, kind): ${mediaKinds.map((k, i) => `#${i + 1}:${k}`).join(", ") || "n/a"}

DEEP SONG ANALYSIS:
- Section length: ${(a.endSec - a.startSec).toFixed(1)}s at ${a.bpm} BPM (${a.peakDensity.toFixed(2)} beats/sec)
- Dynamic range: ${(a.dynamicRange * 100).toFixed(0)}% (${a.dynamicRange > 0.5 ? "huge swings — build/drop structure" : "flat energy — steady groove"})
- Tempo stability: ${(a.tempoStability * 100).toFixed(0)}% (${a.tempoStability > 0.7 ? "locked metronomic" : "loose, human-feel"})
- Brightness: ${(avg(a.brightnessCurve) * 100).toFixed(0)}% (${avg(a.brightnessCurve) > 0.5 ? "bright/airy — hi-hats, cymbals, synths" : "dark/warm — bass-driven, mellow"})
- Quiet ratio: ${(a.quietRatio * 100).toFixed(0)}% of the section is soft
- Energy curve (32 slices, 0-1): [${a.energyCurve.map((n) => n.toFixed(2)).join(",")}]
- Brightness curve: [${a.brightnessCurve.map((n) => n.toFixed(2)).join(",")}]
- Selected cut points (${transitionCount}, in order): times [${a.cutBeatTimes.map((n) => n.toFixed(2) + "s").join(", ")}] energies [${a.cutBeatEnergies.map((n) => n.toFixed(2)).join(",")}]
- Hero drops in this window: [${a.heroBeatTimes.map((n) => n.toFixed(2) + "s").join(", ")}]

SONG FEEL (your read): ${feel}
${prev ? `\nPREVIOUS PLAN (refining, don't restart from scratch):\n- style: ${prev.styleName}\n- grade: ${prev.colorGrade}\n- motion: ${prev.motionStyle}\n- transitions: [${prev.transitions.map((t, i) => `#${i + 1}:${t.type}${t.isHero ? "★" : ""}`).join(", ")}]` : ""}
${userInstruction ? `\nUSER DIRECTION (HIGHEST PRIORITY — obey exactly, override defaults):\n"""${userInstruction}"""\nParse per-clip instructions carefully. Phrases like "clip 2", "second clip", "the 3rd one" refer to CLIP ORDER above. "Remove all transitions on clip 2" → set that clip's transition to "cut" and isHero:false. "Add more transitions" → keep count as-is (already dense) but favor punchy variety. "Make it cinematic" → dissolves + light-leaks. "Make it hype/party" → pushes + flashes + zoom-punch. If the user contradicts a musical rule, obey the user.\n` : ""}

YOUR JOB — think like a specific editor for THIS song:
1. Name a real editing style that fits this exact fingerprint (not generic "cinematic cut"). Reference a real aesthetic — Kolder travel drift, Daniels x Turnstile chaos-cut, Emmanuel Lubezki floating dreamscape, K-pop hard-cut, Bollywood wedding montage, A24 handheld, MTV early-2000s, whatever the song demands.
2. Pick colorGrade + motionStyle that MATCH the brightness and dynamic range (warm/dark songs -> warm-romantic or vintage-film + parallax-drift; bright/punchy -> cinematic-teal or vibrant-party + punch-zoom; ballads -> golden-hour + ken-burns-slow).
3. Design exactly ${transitionCount} transitions — one per CUT POINT, in order (transition[i] corresponds to cut #${1} entering clip #2, cut #2 entering clip #3, etc.). Available transitions (choose from this set only):
   - "cut": clean hard cut, invisible pacing (great on quiet moments)
   - "cross-dissolve", "blur-fade": soft, romantic, ballads
   - "morph-zoom", "zoom-punch": punchy hits, drops, choruses
   - "flash-white", "flash-black": big drops, drama, impact
   - "push-left", "push-right", "push-up": kinetic energy, K-pop, hip-hop
   - "light-leak", "film-burn": warm nostalgia, weddings, sunsets, film aesthetic
   - "glitch": chaos, distortion, use SPARINGLY (max once every 6 cuts)
   Rules: pick transitions matching each cut's energy. Vary types — never repeat the same one more than twice in a row. Ballads use mostly dissolves + cuts. Party songs use pushes + zooms + flashes. Weddings use light-leaks + dissolves + film-burns. Mark isHero:true for the biggest 15-25% cuts (drops). Do NOT set "cut" on high-energy beats unless the user asked for it — use punchy transitions there.
4. captionHook (<=30 chars) and captionOutro (<=25 chars) that echo the song's mood + occasion — never a generic "WEDDING" or heart emoji unless the song is that literal.

Make this plan DIFFERENT from what you'd give any other song. Use the fingerprint as commitment: two songs with different fingerprints must get different styleName, colorGrade, motionStyle, and transition patterns.${userInstruction ? " USER DIRECTION OVERRIDES everything above where they conflict." : ""}`;

    try {
      const { output } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        output: Output.object({ schema: EditPlan }),
        prompt,
        temperature: 0.9,
      });

      const plan = output as EditPlanT;
      while (plan.transitions.length < transitionCount) {
        plan.transitions.push({ type: "cut", isHero: false });
      }
      plan.transitions = plan.transitions.slice(0, transitionCount);
      return plan;
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        return fallbackPlan(data.occasion, transitionCount, data.audio.cutBeatEnergies);
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
  energy: number[],
): EditPlanT {
  const isWedding = occasion.toLowerCase().includes("wedding");
  const softPool = ["cross-dissolve", "blur-fade", "light-leak", "film-burn", "cut"] as const;
  const punchPool = ["morph-zoom", "zoom-punch", "flash-white", "push-left", "push-right"] as const;
  const transitions: EditPlanT["transitions"] = Array.from({ length: count }, (_, i) => {
    const e = energy[i] ?? 0.5;
    const isHero = e > 0.85;
    if (e > 0.6) {
      const pool = isWedding ? [...punchPool, "light-leak" as const] : punchPool;
      return { type: pool[i % pool.length], isHero };
    }
    return { type: softPool[i % softPool.length], isHero: false };
  });
  return {
    styleName: `${occasion} Cinematic Cut`,
    styleReference: "Beat-synced reel with breathing pacing — cuts only on hero moments.",
    pacingNote: "Sparse cuts. Big drops get pushes and flashes. Quiet parts get dissolves.",
    colorGrade: isWedding ? "warm-romantic" : "vibrant-party",
    transitions,
    motionStyle: "ken-burns-fast",
    captionHook: occasion.toUpperCase(),
    captionOutro: "❤",
  };
}