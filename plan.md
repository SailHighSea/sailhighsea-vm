# Plan: Voicemeeter-inspired features

Source: feature review of [Voicemeeter](https://vb-audio.com/Voicemeeter/) (Standard / Banana), mapped onto this app. Most items are another DSP stage in the per-app WASAPI process-loopback path in `src-tauri/src/audio/mirror.rs` (capture, process, replay), so no new engine is needed.

## What Voicemeeter has

- Strips and buses: 3 in / 3 out (Standard), 5 in / 5 out (Banana). Hardware buses A1-A3, virtual buses B1-B2. Any strip can go to any bus.
- Per strip: EQ, compressor, gate, limiter, solo, mute, pan, 3D/binaural.
- Per bus: parametric EQ, limiter, mono, per-output delay.
- Recorder (tape deck), MIDI remote, macro buttons, VBAN network audio, virtual devices and ASIO.

## Already covered

- Per-app volume, mute, live meters; move an app between outputs.
- Mirror an app to several devices with volume and delay trim.
- 10-band graphic EQ with presets and preamp.
- **Compressor + noise gate per app** (done, test21): threshold, ratio, attack, release, make-up, soft knee, gain-reduction meter, presets, remembered per app.

## Roadmap (in priority order)

| # | Feature | How | Effort | Status |
|---|---------|-----|--------|--------|
| 1 | Compressor + gate + limiter | New stage after the EQ in the `run` loop; shared state like `EqShared` | Small | Done |
| 2 | Pan / balance, solo, mono toggle | Per-channel gain in the same loop; solo = mute others and restore | Small | Done (solo also on Cards rows) |
| 3 | Presets / profiles | Save routes, mirrors, EQ and dynamics to the `.ini`; recall from the tray | Small-medium | Done (Settings + tray popup recall) |
| 4 | Global hotkeys and MIDI learn | Tauri global-shortcut plugin; `midir` crate for MIDI faders | Medium | To do |
| 5 | Recorder | Tap the loopback stream and write WAV (`hound` crate) | Medium | To do |
| 6 | Per-output delay on the main output | Same control as the mirror delay trim | Small | To do |
| 7 | Bus routing (strips to buses, per-bus EQ and limiter) | Shared bus buffer so several apps mix into one processed output; turns the app into a matrix mixer | Large | To do |
| 8 | VBAN streaming | UDP packet with a small header | Medium-large | Later |

## Out of scope

- Own virtual audio devices (B1/B2 equivalent): Windows needs a signed kernel driver. Route to VB-Cable or Voicemeeter instead.

## Notes

- All DSP is Windows only for now; Linux and macOS return a "not available" message.
- Processing runs on the captured copy, so the app is parked on a spare output (adds a little latency).
- Keep the README up to date when any of these ship.
