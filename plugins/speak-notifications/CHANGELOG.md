# Changelog

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
