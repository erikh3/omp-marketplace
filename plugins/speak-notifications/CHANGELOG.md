# Changelog

## 0.3.0

- Clarify substantial outcomes, user-action blockers, and cases that should stay silent.
- Supply live enabled state before each model request and request at most one optional completion check for candidate substantial work.
- Add a five-minute silence reminder. Pause during speech, reset after successful playback, coalesce while idle without waking the model, and reset/freeze when disabled.

## 0.2.1

- Show only the off notice when bare `/speak` disables notifications. Keep full status when it enables them.

## 0.2.0

- Add argument completion for `on`, `off`, and `status` after a typed prefix.
- Make bare `/speak` toggle notifications and immediately show the resulting status.

## 0.1.3

- Move unchanged agent guidance into its own source module.

## 0.1.2

- Format status as separate state and local TTS rows. Omit playback errors when none exist.

## 0.1.1

- Require autonomous notifications for blockers, decision requests, long-running operation outcomes, and substantial task completion.
- Hide startup notices and render toggle notices as compact sentences while preserving full instructions in model context.

## 0.1.0

- Add primary-agent-only deliberate local speech notifications and stable usage guidance.
- Add `/speak on`, `/speak off`, and `/speak status`, with session-local state that starts disabled.
- Add a three-item waiting queue, explicit capacity rejection, visible playback errors, and owned-process cancellation.
- Resolve local speech model, voice, and speed from the parent OMP session and pass them explicitly to `omp say`.
