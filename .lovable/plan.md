
# AI Reel Editor — Build Plan

A browser-based AI video editor that turns your birthday/wedding photos + a song into a professionally edited reel with beat-synced transitions, multiple aspect ratios, and AI-directed editing style.

## What you'll get

**Upload & Setup**
- Drag/drop photos and short video clips
- Upload any song (MP3/WAV/M4A)
- Pick aspect ratio: 9:16 Reels, 1:1 Square, 16:9 YouTube, 4:5 Portrait
- Pick occasion: Wedding, Birthday, Anniversary, Party (feeds the AI director)

**Audio Intelligence** (the core of what you asked for)
- **Beat detection** — analyzes the waveform in the browser (Web Audio API) to find every beat's timestamp with confidence scores
- **AI "Music Director"** — sends audio metadata + tempo + energy curve + occasion to Lovable AI (Gemini). It researches similar edits, returns:
  - Editing style reference (e.g. "fast-cut wedding hype à la cinematic wedding films with slow-mo intros")
  - Recommended transition types per beat (whip pan, zoom punch, flash cut, cross-dissolve, glitch)
  - Which beats are "hero" moments (drops) vs regular
  - Pacing curve (build-up → drop → release)
- **AI auto-pick best 30s** — analyzes energy peaks, picks the most exciting continuous section
- **Manual audio trim** — waveform scrubber with in/out handles
- **Fade in/out + volume slider**
- **Transition SFX** — auto-adds whoosh/impact/riser sounds on major transitions (bundled royalty-free pack)

**AI Editor**
- Every transition starts and ends exactly on a beat (frame-accurate)
- Effects synced to song energy: zoom-punches on drops, calm dissolves on soft parts
- Ken Burns motion on stills; smart-crop for aspect ratio
- Color grading presets tuned to occasion (warm wedding, vibrant birthday)

**Preview & Export**
- Live canvas preview synced with audio playback
- Export to MP4 via MediaRecorder (client-side, no server render queue)
- Save projects to your account (Lovable Cloud)

## Technical approach

- **Stack**: TanStack Start + Tailwind + shadcn (existing template)
- **Backend**: Lovable Cloud for auth, project storage, uploaded media (Storage bucket)
- **AI**: Lovable AI Gateway (`google/gemini-3-flash-preview`) — server function receives audio analysis JSON, returns edit plan JSON (structured output)
- **Beat detection**: Web Audio API + custom onset-detection algorithm (low-frequency energy peaks) — runs in browser worker
- **Rendering**: Canvas 2D compositor driven by `requestAnimationFrame`, recorded via `MediaRecorder` + `MediaStreamAudioDestinationNode` for the exported MP4/WebM
- **SFX pack**: 4-5 bundled royalty-free transition sounds in `public/sfx/`

## Realistic limits (being honest)

- Export length capped at ~60s (browser memory for MediaRecorder)
- Video clips auto-trimmed to 3s max each
- First render can take 30-90s depending on device
- iOS Safari may export WebM instead of MP4 (browser limitation)

## Build order (this session)

1. Enable Lovable Cloud + storage bucket for uploads
2. Design system: cinematic dark UI (editor feel, not generic SaaS)
3. Upload/media library screen
4. Audio panel: waveform, trim, fade, AI auto-pick, beat detection
5. AI Director server function (analyzes audio features + occasion → edit plan)
6. Preview canvas + timeline synced to beats
7. Export via MediaRecorder with SFX mixed in
8. Project save/load

Ready to build?
