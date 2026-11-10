<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icons/brand/full-logo-dark.svg">
    <img src="icons/brand/full-logo-light.svg" alt="Tonic" width="360">
  </picture>
</p>

# Tonic: key & scale finder (PWA)

Listens to a song through the microphone (or reads an audio file) and tells you:

- the **key** (e.g. F♯ minor) and **scale/mode** (major, natural/harmonic/melodic minor, Dorian, Mixolydian, Lydian, Phrygian)
- the scale's notes with degrees, on a keyboard
- the 7 diatonic chords with Roman numerals (tap to hear them)
- relative key / parent key, Camelot code, and the song's tuning (A4 in Hz)
- the next-closest matches, so relative-key mix-ups are easy to spot

Everything runs on-device. No build step, no dependencies, no server.

## Run locally

```bash
cd tonic
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

`localhost` counts as a secure origin, so the mic and service worker work.

## Deploy

Upload the folder to any static host with HTTPS (Vercel, Netlify, Cloudflare Pages, GitHub Pages). HTTPS is required for microphone access and installation.

- **Vercel:** `npx vercel` from inside the folder
- **Netlify:** drag the folder onto app.netlify.com/drop
- **GitHub Pages:** push to a repo, enable Pages on the branch root

Then open it on your phone → Install (Android/Chrome) or Share → Add to Home Screen (iOS).

When you change files, bump `VERSION` in `sw.js` (and `APP_VERSION` in `js/app.js`). Installed copies download the new version in the background and show an **Update available · Refresh** banner; tapping Refresh switches to it.

## Files

```
index.html              markup
styles.css              tokens (light/dark), layout
js/dsp.js               FFT, spectral peak picking, harmonic suppression, chroma + bass chroma, tuning
js/theory.js            key profiles, key/mode scoring, spelling, chords, Camelot
js/app.js               mic + file pipelines, dial/piano/readout rendering, preview synth, PWA glue
sw.js                   offline cache per version; waits for the user to tap Refresh before updating
manifest.webmanifest    install metadata
icons/                  favicon + PNG app icons; icons/brand/ holds the logo files
```

## How detection works

1. **Spectrum** — mic: `AnalyserNode` (32768-pt FFT, ~1.5 Hz bins). Files: decoded at 11 kHz, 8192-pt Hann FFT, 50% hop.
2. **Peaks** — local maxima 58–1800 Hz within 40 dB of the frame max, parabolic interpolation for exact frequency. Peaks sitting on the 3rd/5th/6th/7th harmonic of a stronger lower peak are down-weighted.
3. **Tuning** — circular mean of every peak's offset from equal temperament, so songs tuned to A=432 or A=446 still bin correctly.
4. **Chroma** — peaks folded into 12 pitch classes (Gaussian weight by cents off-pitch), normalised per frame. A separate **bass chroma** (< 130 Hz) is kept because the bass line is the strongest tonic cue.
5. **Key scoring** — Pearson correlation against rotated Krumhansl–Kessler and Temperley profiles for all 24 major/minor keys, plus a bass bonus for the tonic. After 20 s of music, Dorian/Mixolydian/Lydian/Phrygian profiles (parent profile with the characteristic note swapped) compete too, with a prior penalty and a margin they must clear. Minor results are checked for a raised 7th (harmonic) and raised 6th+7th (melodic).
6. **Live stability** — older material fades with a 30 s half-life; a new key must win 3 evaluations in a row (6 if it's just a re-reading of the same notes, like relative major/minor) before the display switches.

## Known limits

- Relative keys (C major / A minor) share all their notes. Loops like i–VI–III–VII with no tonic emphasis are genuinely ambiguous; check "Other close matches".
- Songs that change key midway report the dominant key (live mode follows changes after ~30 s).
- Heavily distorted or percussion-only tracks give weak results.
- iOS stops the microphone when the app goes to the background.

Tuning knobs live at the top of `js/app.js` (`QUIET_DB`, `FIRST_READ`, `LIVE_HALF_LIFE`) and in `TYPES` / `MODE_MARGIN` in `js/theory.js`.
