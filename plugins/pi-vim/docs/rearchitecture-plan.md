# pi-vim re-architecture implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Refactor `plugins/pi-vim` from a 1441-line `ModalVimEditor` monolith
into the layered engine described in `docs/architecture.md`, with **no observable
behavior change**.

**Architecture:** Ports-and-adapters around a pure vim engine (grammar evaluator
+ named motion/operator/action registries + declarative keymap), reading through
a `BufferView` and returning `EditIntent[]` applied by one `applyIntents` site;
the keystroke-replay constraint is confined to `host/keystroke-bridge.ts`; a
single `runKey` owns the undo boundary. See `docs/architecture.md` §4–§8.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`), Bun test runner,
`@oh-my-pi/*` peer deps. No new runtime dependency.

---

## Ground rules (apply to EVERY task)

- **The 698-test suite is the contract.** After every task:
  - Run `bun test` in `plugins/pi-vim/` → expect `698 pass, 0 fail`.
  - Run `bun run typecheck` in `plugins/pi-vim/` → expect no output / exit 0.
  - Only then commit. A task is not done until both are green.
- **Vendored files are frozen.** Never edit `src/vim/{motions,text-objects,visual,types}.ts`.
- **Golden rule (spec §9).** Within a single task, keep each piece of state in
  **one** representation. Never split one field's readers across an old private
  field and a new struct mid-task — it fails `strict`/`verbatimModuleSyntax` and
  reintroduces scattered mutation. A subsystem flips representation only at its
  own atomic task.
- **`verbatimModuleSyntax`:** every new module must use `import type` for
  type-only imports and `.js`/`.ts` extensions consistent with the existing code
  (current code imports with `.js`, e.g. `./vim/bridge.js`).
- **Commits:** conventional, `pi-vim` scope, short. One commit per completed task
  (or per green sub-step where noted). Branch: `add-pi-vim-plugin` (current).
- **Line numbers drift.** This plan cites current symbols by name; re-locate exact
  ranges with `read`/`grep` before editing — do not trust any line number here.
- **TDD applies to NEW units only** (bridge round-trips, dispatch fake-host,
  registries). Moved logic is guarded by the existing suite, which is the
  pre-existing oracle.

The two riskiest tasks are **Task 6 (motions+operators atomic cutover)** and
**Task 7 (intents/evaluator)**. Everything before them is independently landable.

---

## Task 1: Extract the undo/redo timeline → `src/host/history.ts`

Lowest-risk move; the timeline is already cohesive and only `handleInput`'s
wrapper and the `u`/`Ctrl+r` keys touch it.

**Files:**
- Create: `src/host/history.ts`
- Modify: `src/modal-editor.ts` (remove the timeline internals, delegate to the module)
- Test: existing `test/editor/undo.test.ts` (must stay green, unchanged)

- [x] **Step 1: Create `src/host/history.ts`** with the timeline lifted out of
  `modal-editor.ts`. Move the current `EditSnapshot` type and the bodies of
  `#snapshot`, `#beginChange`, `#commitChange`, `#undo`, `#redo`, `#restore` and
  the `MAX_HISTORY` cap into a small class that operates on snapshots only (no
  editor reference):

  ```ts
  export interface Snapshot { text: string; line: number; col: number; }

  const MAX_HISTORY = 500; // keep the existing cap

  export class History {
    #undo: Snapshot[] = [];
    #redo: Snapshot[] = [];
    #pending: Snapshot | null = null;

    /** Record the pre-command state. Mirrors the old #beginChange. */
    begin(text: string, cursor: { line: number; col: number }): void {
      this.#pending = { text, line: cursor.line, col: cursor.col };
    }

    /** Push one unit iff the text actually changed (old #commitChange guard). */
    commit(text: string, _cursor: { line: number; col: number }): void {
      const before = this.#pending;
      this.#pending = null;
      if (before === null || before.text === text) return;
      this.#undo.push(before);
      if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
      this.#redo.length = 0;
    }

    /** Old #undo: returns the snapshot to restore to, or null. */
    undo(current: Snapshot): Snapshot | null {
      const prev = this.#undo.pop();
      if (prev === undefined) return null;
      this.#redo.push(current);
      return prev;
    }

    redo(current: Snapshot): Snapshot | null {
      const next = this.#redo.pop();
      if (next === undefined) return null;
      this.#undo.push(current);
      return next;
    }
  }
  ```

  Preserve the EXACT push/guard/clear semantics of the current methods — read
  them first and match behavior (the guard `before.text === text`, the redo
  clear on commit, the pop/push on undo/redo). Adjust signatures above only if
  the current code differs.

- [x] **Step 2: Rewire `modal-editor.ts`** to hold `#history = new History()` and
  replace the six private methods' call sites with `#history.begin/commit/undo/redo`.
  The editor still owns applying a restored `Snapshot` (its `setText` + cursor
  move), since `History` is now editor-agnostic. Remove `#undoStack`, `#redoStack`,
  `#pendingSnapshot`, `EditSnapshot`, `MAX_HISTORY` from `modal-editor.ts`.

- [x] **Step 3: Verify** — `bun test` (698 pass) and `bun run typecheck` (clean).
  `test/editor/undo.test.ts` is the focused oracle; run
  `bun test test/editor/undo.test.ts` first for a fast signal.

- [x] **Step 4: Commit** — `git add plugins/pi-vim/src/host/history.ts plugins/pi-vim/src/modal-editor.ts` then
  `git commit -m "refactor(pi-vim): extract undo timeline into History"`.

---

## Task 2: Extract the ex command line → `src/ex/parser.ts` + `src/ex/commands.ts`

Touches only host callbacks (`runExCommand`, `notifyUser`, `getCommandNames`); no
operator/motion entanglement.

**Files:**
- Create: `src/ex/parser.ts`, `src/ex/commands.ts`
- Modify: `src/modal-editor.ts` (`#handleEx`/`#submitEx`/`#dispatchEx` become thin)
- Test: existing `test/editor/ex.test.ts` (stay green)

- [x] **Step 1: Create `src/ex/parser.ts`** — pure parsing of the accumulated ex
  line into a structured result. Move the parse logic currently inside
  `#submitEx`/`#dispatchEx` (command name vs search, reserved/quit-name detection,
  argument split):

  ```ts
  export type ExParse =
    | { kind: "command"; name: string; args: string }
    | { kind: "search"; pattern: string }
    | { kind: "empty" };

  export function parseExLine(line: string): ExParse { /* lift current logic */ }
  ```

  Keep the current `QUIT_NAMES` / `RESERVED_NAMES` sets and the reserved-name
  precedence rule (a registered command named `w` must not shadow reserved `:w`)
  intact — `test/editor/ex.test.ts` pins this.

- [x] **Step 2: Create `src/ex/commands.ts`** — dispatch a parsed ex line against
  the host, returning what the editor must do. Until intents exist (Task 7),
  return a small result the editor executes imperatively:

  ```ts
  export interface ExHost {
    runExCommand?: (line: string) => void | Promise<void>;
    notifyUser: (message: string) => void;
    getCommandNames: () => ReadonlySet<string>;
  }
  export function dispatchEx(parse: ExParse, host: ExHost): void | Promise<void> {
    /* lift the current #dispatchEx body: quit handling, runExCommand vs
       notifyUser fallback, and the async setText/cursor restore stays with the
       EDITOR caller (host-side), not here — see spec §5.15. */
  }
  ```

  The async post-await buffer/cursor restore currently in `#dispatchEx` is
  omp-side bookkeeping: leave it in `modal-editor.ts` around the `dispatchEx`
  call, not inside the ex module.

- [x] **Step 3: Rewire `modal-editor.ts`** — `#handleEx` stays as the buffer
  manager (accumulate chars into `#exCommand`, fire `onExCommandChange`); on submit
  it calls `parseExLine` then `dispatchEx`. Remove the parse/dispatch bodies.

- [x] **Step 4: Verify** — `bun test` (698 pass), `bun run typecheck` (clean);
  `bun test test/editor/ex.test.ts` first.

- [x] **Step 5: Commit** — `git commit -m "refactor(pi-vim): extract ex parser and command dispatch"`.

---

## Task 3: Extract the keystroke bridge → `src/host/keystroke-bridge.ts`

Move OUR (non-vendored) bridge code out of `vim/`, plus the `#moveToAbs` replay
loop currently in `modal-editor.ts`. This is the one task that edits a test file
(a mechanical import re-point, spec §10).

**Files:**
- Create: `src/host/keystroke-bridge.ts`
- Delete: `src/vim/bridge.ts`
- Modify: `src/modal-editor.ts` (import path; extract `#moveToAbs` loop)
- Modify: `test/vim/bridge.test.ts` (import path re-point) — and consider moving it
  to `test/host/keystroke-bridge.test.ts` to match the source move
- Test: new round-trip tests (TDD), existing `test/vim/bridge.test.ts`

- [x] **Step 1 (TDD, new): add coordinate round-trip tests** for the bridge over
  the unicode fixtures in `test/support/fixtures.ts`, asserting
  `absToLineCol(lineColToAbs(x)) === x` and grapheme-step counts on
  emoji/combining/CJK lines. Put them where the bridge test will live. Run and
  confirm they pass against the CURRENT `src/vim/bridge.ts` (they characterize
  existing behavior before the move).

- [x] **Step 2: Create `src/host/keystroke-bridge.ts`** = the exact contents of
  `src/vim/bridge.ts` (converters `lineColToAbs`, `absToLineCol`, `graphemeCount`,
  `graphemeSteps`) **plus** the replay loop extracted from `modal-editor.ts`'s
  `#moveToAbs` and its `#repeat`/`SEQ` helpers. Expose:

  ```ts
  export function moveCursor(view: BufferView, to: Pos, replay: (seq: string, n: number) => void): void;
  ```

  where `replay` is the editor's keystroke-forwarding primitive (kept in the
  editor for now; Task 4 formalizes it). Preserve the EXACT sequence: line delta
  (up/down) first, then column delta (left/right); rely on the base editor's EOL
  clamp; keep the `<Esc>` left-step logic where it is (INSERT→NORMAL in the
  editor, not the bridge).

- [x] **Step 3: Delete `src/vim/bridge.ts`**; update `modal-editor.ts` to import
  the converters from `../host/keystroke-bridge.js` and call the extracted
  `moveCursor`.

- [x] **Step 4: Re-point the bridge test** — move `test/vim/bridge.test.ts` →
  `test/host/keystroke-bridge.test.ts` and fix its import to
  `../../src/host/keystroke-bridge.ts`. Merge the Step-1 round-trip tests here.

- [x] **Step 5: Verify** — `bun test` (698 pass; count unchanged since it's a move
  plus added round-trip cases — if you added N new cases, expect `698+N`),
  `bun run typecheck` (clean). Confirm no file still imports `./vim/bridge`.

- [x] **Step 6: Commit** — `git commit -m "refactor(pi-vim): move keystroke bridge to host/ and extract moveToAbs"`.

---

## Task 4: Introduce `BufferView` + `HostEffects` as a thin facade (NO intents)

Deliver the read/effect split as interfaces the current imperative editor already
satisfies. No `EditIntent`, no `applyIntents` yet — that is Task 7.

**Files:**
- Create: `src/host/adapter.ts` (interfaces only, for now)
- Modify: `src/modal-editor.ts` (declare it `implements HostEffects`; add any
  missing thin methods that wrap existing behavior)

- [x] **Step 1: Create `src/host/adapter.ts`** with the two interfaces from spec
  §5.2–§5.3, but WITHOUT `applyIntents` yet:

  ```ts
  import type { VimMode } from "../vim/types.js";
  export interface Pos { line: number; col: number; }
  export interface AbsRange { start: number; end: number; } // UTF-16 abs offsets

  export interface BufferView {
    getLines(): readonly string[];
    getText(): string;
    getCursor(): Pos;
  }
  export interface HostEffects extends BufferView {
    moveCursor(to: Pos): void;
    replaceRange(range: AbsRange, text: string): void; // insert = empty range
    forward(data: string): void;
    signalMode(mode: VimMode): void;
    signalEx(buffer: string | null): void;
    runEx(line: string): void | Promise<void>;
    notify(message: string): void;
    getCommandNames(): ReadonlySet<string>;
  }
  ```

- [x] **Step 2: Make `ModalVimEditor implements HostEffects`.** Most methods
  already exist (`getLines`/`getText`/`getCursor`); add thin wrappers for the rest
  that call the current internals (`moveCursor` → the extracted bridge;
  `replaceRange` → the current `#deleteAbsRange`/`insertTextAtCursor` combination;
  `forward` → `super.handleInput`; `signalMode` → `setMode`'s `onModeChange`;
  etc.). This is pure interface-satisfaction — behavior unchanged.

- [x] **Step 3: Verify** — `bun test` (698 pass), `bun run typecheck` (clean).

- [x] **Step 4: Commit** — `git commit -m "refactor(pi-vim): add BufferView/HostEffects facade over the editor"`.

---

## Task 5: Consolidate the 7 fields → `src/engine/state.ts`

Mechanical, all-at-once swap of the implicit state machine for one typed struct.

**Files:**
- Create: `src/engine/state.ts`, `src/engine/registers.ts`
- Modify: `src/modal-editor.ts` (replace `#mode`/`#count`/`#op`/`#textObject`/
  `#charPending`/`#replacePending`/`#pendingG`/`#lastCharMotion`/`#visualAnchor`/
  `#register`/`#exCommand` with one `#state: VimState`)

- [x] **Step 1: Create `src/engine/state.ts`** exactly as spec §5.6 (`VimState`,
  `InputState`, `RecordedCommand`, `RegisterFile` import) plus the pure helpers
  `resetInput(state)`, `takeCount(state): number`, `hasPending(state): boolean`
  — lifted from the current `#resetPending`/`#takeCount`/`#hasPending`.

  ```ts
  import type { CharMotion, VimMode } from "../vim/types.js";
  import type { RegisterFile } from "./registers.js"; // create RegisterFile here or in Task 6
  export interface VimState { /* ...spec §5.6... */ }
  export interface InputState { /* ...spec §5.6... */ }
  export type RecordedCommand = { keys: readonly string[] };
  export function resetInput(s: VimState): void { /* clear input.* like #resetPending */ }
  export function takeCount(s: VimState): number { /* parse+clamp like #takeCount */ }
  export function hasPending(s: VimState): boolean { /* like #hasPending */ }
  ```

  For this task, put a minimal `RegisterFile` (unnamed-register only) in
  `src/engine/registers.ts` now (spec §5.12) so the type resolves; the current
  `#register` `{text,linewise}` maps onto `RegisterFile.get()/set()`.

- [x] **Step 2: Swap the fields in `modal-editor.ts`** in one pass. Every read of
  `#mode` → `#state.mode`, `#op` → `#state.input.operator`, `#count` →
  `#state.input.count`, etc. Do it for ALL readers at once (golden rule); do not
  leave any method reading an old field. `setMode` mutates `#state.mode` then
  fires `onModeChange`.

- [x] **Step 3: Verify** — `bun test` (698 pass), `bun run typecheck` (clean). The
  full suite is the oracle since this touches every dispatch path.

- [x] **Step 4: Commit** — `git commit -m "refactor(pi-vim): consolidate editor state into VimState/InputState"`.

---

## Task 6: Registries + keymap; cut over motions+operators ATOMICALLY (riskiest)

Standalone motions, operator targets, and the shared apply paths
(`#applyCharwiseTarget`/`#applyLinewiseOperator`, gated by `input.operator`) cannot
be split — they flip together. Standalone *actions* may be ported first as warm-up.

- Create: `src/engine/motion-registry.ts`, `src/engine/operator-registry.ts`,
  `src/engine/action-registry.ts`, `src/engine/visual-controller.ts`, `src/engine/keymap.ts`
- Create: `src/engine/dispatch.ts` (evaluator core; `runKey` lands in Task 7)
- Modify: `src/modal-editor.ts` (dispatch delegates to the evaluator)
- Test: NEW `test/engine/dispatch.test.ts` (REQUIRED, fake host); existing
  `test/editor/{motions,operators,text-objects,visual,modes}.test.ts` stay green

- [x] **Step 1: Create the registries** wrapping the vendored pure functions.
  `motion-registry.ts` per spec §5.7 (`Motion`, `MotionResult`, `motions` record);
  `operator-registry.ts` per §5.8 (`d`/`c`/`y`); `action-registry.ts` per §5.9
  (mode entries, `x s r p P u Ctrl+r ; ,`, doubled `dd cc yy`, visual `o`). Move
  the existing bodies of `#applyCharwiseTarget`, `#applyLinewiseOperator`,
  `#deleteAbsRange`, `#yankToRegister`, `#paste` into the operator/action
  registries, preserving behavior. Encode the special forms (spec §5.11.1):
  `cw`→`ce`, `gg`, doubled operators, visual `o`, `;`/`,` till-offset.
  Also create `visual-controller.ts` (spec §5.14): `selectionRange(state, view)`
  wrapping vendored `visual.ts`, lifting the current visual range computation out
  of `#handleOperatorKey`/`#handleVisual`.

- [x] **Step 2: Create `keymap.ts`** (spec §5.10) — one `Record<VimMode, Record<string, Command>>`
  covering every key the current `#handleNormalKey`/`#handleVisual` switch handles.
  Cross-check against the switch cases so nothing is dropped.

- [x] **Step 3: Create `dispatch.ts` evaluator core** — `evaluate(ctx, key)` per
  spec §5.11 steps 3–4 (accumulate `InputState`; on a complete command resolve the
  motion ONCE into a `MotionResult`, interpret per context — standalone move vs
  operator `AbsRange` vs visual extent — and run operator/action). It returns
  intents-or-effects; for THIS task (pre-intents) it may call `HostEffects`
  methods directly (the facade from Task 4). Full `EditIntent` return + `runKey`
  is Task 7.

- [x] **Step 4 (TDD, REQUIRED): `test/engine/dispatch.test.ts`** with a fake
  `HostEffects` over a plain string buffer (a recording double), asserting the
  effects for representative key sequences (`dw`, `de`, `cw`, `2dd`, `x`, `p`,
  `v`+motion+`d`, `gg`, `;`). These localize regressions the integration suite can
  only detect globally. Write them to characterize the behavior you are cutting
  over to; run against the new evaluator.

- [x] **Step 5: Atomic cutover** — replace `#handleNormalKey`, `#handleOperatorKey`,
  `#handleVisual` bodies with a single delegation to `evaluate`. Delete the old
  switches and the now-unused private apply methods. This is ONE commit; do not
  interleave with unrelated changes.

- [x] **Step 6: Verify** — `bun test` (expect `698 + new dispatch cases` pass),
  `bun run typecheck` (clean). Run the motion/operator/visual editor test files
  individually first to localize any break; they are the exhaustive oracle.

- [x] **Step 7: Commit** — `git commit -m "refactor(pi-vim): table-driven motion/operator/action dispatch"`.

---

## Task 7: Introduce `EditIntent` + `applyIntents` + `runKey` (second atomic cutover)

Engine units stop calling `HostEffects` imperatively and start *returning*
`EditIntent[]`; `runKey` becomes the single undo-boundary owner.

**Files:**
- Create: `src/engine/intent.ts`
- Modify: `src/host/adapter.ts` (add `applyIntents`), `src/engine/dispatch.ts`
  (evaluator returns `{intents, undoUnit}`; add `runKey`), the registries (return
  intents), `src/modal-editor.ts` (`handleInput` → `runKey`)
- Test: NEW `test/engine/intent-order.test.ts`; existing suite stays green

- [x] **Step 1: Create `src/engine/intent.ts`** — the `EditIntent` union (spec §5.5).

- [x] **Step 2: Convert registries + evaluator to return `EditIntent[]`.** Each
  operator/action returns intents instead of calling `HostEffects`. `evaluate`
  returns `{ intents: EditIntent[]; undoUnit: boolean }` and sets `undoUnit` per
  spec §5.11 step 5 (true for INSERT `forward` and completed mutating NORMAL
  commands; false for pure motions/mode switches). On a completed mutating
  command, copy `input.keys` → `state.lastChange`.

- [x] **Step 3: Add `applyIntents(host, intents)`** to `src/host/adapter.ts` —
  a `switch` over `EditIntent.kind` executing in **strict emission order** (spec
  §5.3). `runEx` may `await` and owns the async buffer/cursor restore (spec §5.15).

- [x] **Step 4: Add `runKey(state, host, key)`** to `dispatch.ts` exactly as spec
  §5.11: `evaluate` → if `undoUnit` `history.begin` → `applyIntents` → if
  `undoUnit` `history.commit` (no-op if text unchanged). This is the ONLY caller
  of `history.begin/commit`. Point `ModalVimEditor.handleInput` at `runKey`
  (keeping the pre-engine `Esc`/INSERT-left-step guard in the shell).

- [x] **Step 5 (TDD): `test/engine/intent-order.test.ts`** — assert the emitted
  `EditIntent[]` order for the load-bearing sequences (spec §6 ordering oracle):
  `o` (moveEOL → setMode insert → replaceRange "\n"), `c`-family (delete →
  setMode), paste (insert → moveCursor back), INSERT-exit. Guards against reorder.

- [x] **Step 6: Verify** — `bun test` (all pass, incl. new order tests),
  `bun run typecheck` (clean). Re-run `test/editor/undo.test.ts` explicitly to
  confirm the boundary rule preserved smoke #29–#39 undo units.

- [x] **Step 7: Commit** — `git commit -m "refactor(pi-vim): engine returns EditIntents; runKey owns the undo boundary"`.

---

## Task 8: Shrink the shell + final verification

**Files:**
- Modify: `src/modal-editor.ts` (reduce to the §5.16 shell), `src/index.ts` (unchanged
  responsibility; confirm imports)

- [x] **Step 1: Reduce `modal-editor.ts`** to: `#state`, the `HostEffects`
  implementation bound to `this`, the `handleInput` guard + `runKey` call, and the
  base-class wiring (`on*`, `runExCommand`, `getCommandNames`). Delete any dead
  private methods left after Tasks 1–7. Target: well under a few hundred LOC.

- [x] **Step 2: Confirm `index.ts` is unchanged in responsibility** — editor
  registration, `ModeWidget`, cursor shapes, `onModeChange`/`onExCommandChange`,
  the `runExCommand → sendUserMessage` wiring. Only import paths may change.

- [x] **Step 3: Full verification** — `bun test` (all pass), `bun run typecheck`
  (clean). Sanity-run `bun test` once more from a clean state.

- [x] **Step 4: Update `docs/architecture.md`** — flip the `Status:` header from
  "design only" to "implemented"; note the as-built module list matches §8.

- [x] **Step 5: Commit** — `git commit -m "refactor(pi-vim): shrink ModalVimEditor to the engine shell"`
  and `git commit -m "docs(pi-vim): mark architecture as implemented"` (or fold
  the doc update into the shell commit).

---

## Self-review checklist (run after implementing, before declaring done)

- [x] Every task ended with `bun test` green + `bun run typecheck` clean.
- [x] `src/vim/{motions,text-objects,visual,types}.ts` are byte-identical to
      pre-refactor (`git diff` shows no changes to them across the whole branch).
- [x] No file imports `./vim/bridge` anymore; `src/vim/bridge.ts` is deleted.
- [x] `history.begin/commit` units are opened only by `runKey` and the `.`-repeat
      replay wrapper (`repeatChange`), both guarded by `state.replaying` so a
      replay never nests a second unit.
- [x] `applyIntents` is the only site that performs effects.
- [x] Motions resolve once; no motion logic is duplicated between standalone and
      operator paths.
- [x] The final file tree matches spec §8.
- [x] The undo test file and the new dispatch/intent-order tests all pass.
