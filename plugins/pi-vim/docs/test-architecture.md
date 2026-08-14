# pi-vim test architecture

Design for a comprehensive, extensible test suite for the `pi-vim` plugin.
**Status: implemented.** The suite is built and green — 826 tests across 23
files (`bun test`, ~1.2 s), with `bun run typecheck` clean. This document is the
architecture reference; the `smoke.ts` cutover (§12) is complete.

## 1. Motivation & goals

The core (`src/modal-editor.ts`, ~1440 lines) is about to be refactored, and new
vim features are expected (README already lists gaps: named registers, system
clipboard, `.` repeat). The suite must therefore:

1. **Pin today's observable behavior as the contract.** The current behavior is
   the spec. A refactor that preserves behavior must keep every test green; a
   refactor that changes behavior must change exactly the tests that encode that
   behavior, visibly, in the diff.
2. **Be cheap to extend.** Adding coverage for a new key or motion should be a
   one-line table row, not a new procedural block. Adding a whole new feature
   area should be a new file that reuses the shared harness.
3. **Localize failure.** A broken motion should fail one named case, not abort a
   1000-line script (today's `smoke.ts` is one linear file; the first failure
   still runs the rest, but there is no isolation, filtering, or per-case
   naming beyond a string).
4. **Run headless and fast.** No TTY, no real theme, no network.

### Non-goals

- Testing the vendored `src/vim/*` files for *vim correctness* against real vim.
  They are copied verbatim from `lajarre/pi-vim` (MIT). We test them as a
  **drift detector** and as executable documentation of the contract
  `modal-editor.ts` relies on, not as a reimplementation of vim's spec.
- Visual/terminal rendering fidelity. `ModeWidget` output is asserted as strings;
  we do not spin a real TUI.

## 2. Current state (baseline)

- Runtime: **Bun 1.3.14** (`package.json` → `bun-types`, `bun.lock`; runner `bun test`).
- Prior baseline (now migrated): a single `smoke.ts` with 73 hand-rolled
  `check(name, actual, expected)` assertions — the behavior oracle the current
  suite was validated against before it was deleted in the §12 cutover.
- Construction seam proven headless: `new ModalVimEditor(themeStub)` with a
  one-field theme stub (`{ borderColor }`) drives real editing through
  `handleInput` without `render()`. The test suite builds on the same seam.
- No test runner or coverage previously; `bun test` + `bun test --coverage` now
  cover both. No CI, by choice.

### Testable seams (what the suite targets)

| Unit | File | Surface | How tested |
| --- | --- | --- | --- |
| Pure motion logic | `src/vim/motions.ts` | exported pure fns | direct call, table-driven |
| Text objects | `src/vim/text-objects.ts` | exported pure fns | direct call, table-driven |
| Visual geometry | `src/vim/visual.ts` | exported pure fns | direct call, table-driven |
| Offset/keystep bridge | `src/host/keystroke-bridge.ts` | `lineColToAbs`/`absToLineCol`/`graphemeSteps` | direct call + round-trip properties |
| Config loader | `src/host/config.ts` | `loadPiVimConfig` merge/validate | direct call, table-driven |
| Mode-change hooks | `src/host/mode-effects.ts` | shell-hook dispatch | direct call, spy on shell |
| Modal editor | `src/modal-editor.ts` | `handleInput`, `mode`, callbacks | **integration** via keystroke DSL |
| Mode widget | `src/mode-widget.ts` | `render(width)` | string/snapshot assertions |
| Extension wiring | `src/index.ts` | `piVim(pi)` + event handlers | mock `ExtensionAPI`/`ctx` |

## 3. Framework decision

**Use Bun's built-in test runner (`bun test`).** Rationale:

- Zero new runtime dependency — Bun is already the toolchain. Aligns with the
  "minimize dependencies / prefer what's already here" constraint.
- Jest-compatible API (`describe`, `test`, `test.each`, `expect`, `beforeEach`),
  built-in snapshots, `bun test --coverage`, per-file/per-name filtering, watch
  mode. Everything the layered suite needs, out of the box.
- Discovers `*.test.ts` anywhere; TS runs natively (no build step), matching how
  `smoke.ts` already runs.

Rejected alternatives:

- **Vitest / Jest** — real dependency trees, config, and a second runtime story
  on top of Bun. No feature we need that `bun test` lacks here.
- **Keep the hand-rolled `check()`** — no isolation, no name-level filtering, no
  coverage, no snapshots; every new case is boilerplate. It does not scale to
  the coverage matrix in §7.

Optional, additive, **not** in the baseline:

- **`fast-check`** (property-based testing, well-documented MIT/open-source) for
  the pure `src/vim/*` invariants only (see §9). Introduced behind its own file
  so the core suite stays dependency-free; adopt only if the property layer earns
  its keep.

## 4. Directory layout

```
plugins/pi-vim/
  src/…                         # unchanged
  test/
    support/
      harness.ts                # editor factory + captured host effects
      harness.test.ts           # harness self-test
      keys.ts                   # keystroke-notation → raw byte sequences
      state.ts                  # cursor-marker string  <->  {text,line,col}
      fixtures.ts               # shared unicode / multiline sample buffers
    vim/                        # Layer 1 — pure vendored fns
      motions.test.ts
      text-objects.test.ts
      visual.test.ts
    editor/                     # Layer 2 — modal-editor integration (the bulk)
      modes.test.ts             # mode transitions (INSERT/NORMAL/VISUAL/EX)
      motions.test.ts           # h/l/j/k, w/b/e, 0/^/$, {/} , f/t/;/, , %, gg/G, counts
      operators.test.ts         # d/c/y + motions, dd/cc/yy, D/C, x/s/r
      text-objects.test.ts      # di(/ci"/daw/… through the editor
      visual.test.ts            # v/V selection + operators, o swap, paste-replace
      registers.test.ts         # yank/paste, linewise vs charwise, counts
      undo.test.ts              # u / Ctrl+r granularity + timeline
      ex.test.ts                # : command line, quit, dispatch, reserved, notify
      unicode.test.ts           # grapheme/emoji/CJK correctness across motions+edits
    engine/                     # engine units over a fake host
      dispatch.test.ts          # evaluator/runKey per key sequence
      intent-order.test.ts      # emitted EditIntent[] order for load-bearing forms
      normal-keys.test.ts       # X/S/_/gM/J/gJ + dot-repeat NORMAL keys
      register-mirror.test.ts   # unnamed register ↔ OS-clipboard mirror policy
    host/                       # host adapters
      keystroke-bridge.test.ts  # (line,col) offset round-trips + replay counts
      config.test.ts            # pi-vim.json load / merge / validation
      mode-effects.test.ts      # modeChange shell-hook dispatch
    widget/                     # Layer 3 — widget render
      mode-widget.test.ts       # render() per mode + ex, right-alignment
      mode-colors.test.ts       # per-mode color tokens
    extension/                  # Layer 4 — extension wiring
      index.test.ts             # piVim wiring, session_start/shutdown, cursor shapes
  tsconfig.json                 # include test/**/*.ts (see §11)
  package.json                  # scripts: test, test:cov, typecheck (see §11)
```

Files are grouped by concern so a refactor of one area touches one directory,
and a new feature adds one file (or one table row) in the obvious place.

## 5. Test layers

### Layer 1 — pure vendored functions (`test/vim/*`)

Direct calls, no editor. Fast, deterministic. Purpose: (a) executable spec of the
contract `modal-editor.ts` depends on, (b) **drift guard** — if someone
re-vendors `src/vim/*` from upstream and the shape/behavior changes, these fail
loudly instead of silently breaking the editor. Table-driven with `test.each`.

Example shape (`test/vim/motions.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { findWordMotionTarget } from "../../src/vim/motions.ts";

describe("findWordMotionTarget: w (forward word start)", () => {
  test.each([
    // line,                col, → expected col
    ["the quick brown",       0,  4],
    ["the quick brown",       4,  10],
    ["foo.bar",               0,  3],   // punctuation is its own word
    ["  leading",             0,  2],
  ])("%j @%i → %i", (line, col, want) => {
    expect(findWordMotionTarget(line, col, "forward", "start", "word")).toBe(want);
  });
});
```

### Layer 2 — modal editor integration (`test/editor/*`) — the bulk

Drive a real `ModalVimEditor` (real base `CustomEditor`) through `handleInput`,
using the **cursor-marker + keystroke DSL** (§6). Assert on observable state:
buffer text, cursor, `mode`, register behavior (observed by pasting), undo/redo
timeline, and captured ex effects. This layer is where refactor regressions are
caught, because it exercises the same public entrypoint the host uses.

Every case is a row:

```ts
import { vt } from "../support/harness.ts";

describe("dw — delete word", () => {
  vt.each([
    { before: "the |quick brown", keys: "dw",  after: "the |brown"       },
    { before: "|the quick",       keys: "d2w", after: "|"                 },
    { before: "foo|.bar",         keys: "dw",  after: "foo|bar"           },
  ]);
});
```

`|` marks the cursor in both `before` and `after`. `vt.each` builds one
`test(...)` per row: seed the buffer+cursor from `before`, replay `keys`, assert
the rendered `after` and, optionally, the final `mode`. Register and undo are
asserted behaviorally (see §6.3), not via extra case facets.

### Layer 3 — widget render (`test/widget/*`)

Construct `ModeWidget` with a theme stub whose `fg`/`borderColor` are identity or
tagged, call `render(width)`, assert the returned line(s). Covers: label per mode,
`V-LINE` short label, EX line `EX :q_`, right-alignment padding via `visibleWidth`,
and the render cache invalidation on `setMode`/`setExCommand`. Bun snapshots
(`toMatchSnapshot`) pin the exact styled strings so palette/format changes are
visible in review.

### Layer 4 — extension wiring (`test/extension/*`)

Mock `ExtensionAPI` (`pi`) and the UI `ctx`: record `setEditorComponent`,
`setWidget`, `notify`, `getCommands`, and captured `process.stdout.write` cursor
shapes. Invoke `piVim(pi)`, fire the registered `session_start` / `session_shutdown`
handlers, and assert:

- the editor factory returns a `ModalVimEditor` with all five callbacks wired
  (`onModeChange`, `onExCommandChange`, `notifyUser`, `getCommandNames`,
  `runExCommand`);
- `applyMode("insert")` fires on install, emits the INSERT cursor shape, mounts
  the widget `belowEditor`;
- a mode change repaints the widget and writes the mode's `CURSOR_SHAPE`;
- an ex-command change writes the block shape, and clearing restores the mode
  shape;
- `session_shutdown` clears the widget and restores the default editor, and a
  throw from `setEditorComponent(undefined)` is swallowed;
- `ctx.hasUI === false` short-circuits both handlers.

**Ex dispatch (now wired):** `index.ts` sets `editor.runExCommand = (line) =>
pi.sendUserMessage(line)`, so a `:` command (`/name args`, `!cmd`, `/quit`) is
submitted through the host's user-prompt pipeline — the same seam a manually
typed submission uses (idle starts a turn; a streaming turn queues it as a
steer). The wiring test asserts that a dispatched ex command (and `:q`'s
`/quit`) reaches the mocked `pi.sendUserMessage`, so the shipped dispatch path
is exactly the `runExCommand` path the editor tests exercise. (Before this
wiring the editor fell back to `setText`+`onSubmit`, which the interactive host
never wired, so `:` commands silently no-op'd — fixed alongside this plan.)

## 6. Core utility: the keystroke DSL (the extensibility lever)

Three small modules under `test/support/` carry all the shared machinery.

### 6.1 `state.ts` — cursor-marker strings

A buffer state is written as a plain string with a single marker char (default
`|`, configurable for buffers that contain a literal `|`) at the cursor:

```
"the |quick brown"   ⇄   { text: "the quick brown", line: 0, col: 4 }
"line one\nli|ne two" ⇄   { text: "line one\nline two", line: 1, col: 2 }
```

```ts
export interface EditorState { text: string; line: number; col: number; }
export function parseState(marked: string, marker?: string): EditorState;
export function renderState(state: EditorState, marker?: string): string;
```

Assertions compare **rendered strings**, so a failure message shows the whole
buffer with the cursor in place — far more legible than `expected col 4, got 5`.

### 6.2 `keys.ts` — keystroke notation → raw bytes

A vim-like notation string is expanded to the raw terminal bytes the editor
consumes, so tests read like key logs. Special tokens in angle brackets:

| Token | Bytes | Meaning |
| --- | --- | --- |
| `<Esc>` | `\x1b` | Escape (INSERT→NORMAL, cancel) |
| `<CR>` / `<Enter>` | `\r` | submit / ex run |
| `<C-r>` | `\x12` | Ctrl+r (redo) |
| `<C-[>` | `\x1b` | Ctrl+[ |
| `<BS>` | `\x7f` | Backspace (ex editing) |
| `<Up>`/`<Down>`/`<Left>`/`<Right>` | CSI arrows | for INSERT-mode nav cases |
| `<lt>` | `<` | literal `<` |
| `[paste]…[/paste]` | `\x1b[200~`…`\x1b[201~` | bracketed paste wrapper |

Everything else is a literal printable char, replayed one grapheme at a time.

```ts
/** Expand notation into the ordered raw chunks handed to handleInput. */
export function keys(notation: string): string[];
```

The expansion reuses the same escape constants the editor speaks (`SEQ`,
`\x1b[200~`), so the DSL and the code under test cannot drift on byte values.

### 6.3 `harness.ts` — editor factory, effect capture, runner

```ts
export interface HostEffects {
  modes: VimMode[];               // onModeChange log
  exCommands: (string | null)[];  // onExCommandChange log
  dispatched: string[];           // runExCommand command lines
  notifications: string[];        // notifyUser messages
  submitted: string[];            // onSubmit (fallback path)
}

export interface Harness {
  ed: ModalVimEditor;
  fx: HostEffects;
  send(notation: string): void;   // keys(notation) → handleInput per chunk
  state(): string;                // renderState(getText + getCursor)
  register(): { text: string; linewise: boolean } | null; // via probe paste, see below
}

/** Build a headless editor with a theme stub and all host callbacks captured. */
export function createHarness(opts?: {
  commandNames?: string[];        // seeds getCommandNames
  wireRunExCommand?: boolean;     // default true; false → exercise setText+onSubmit fallback
}): Harness;

/** Table-driven case runner. Seeds `before`, sends `keys`, asserts `after` (+ optional facets). */
export const vt: {
  (c: VimCase): void;             // single case → one test()
  each(cases: VimCase[]): void;   // many → describe/test.each
};

export interface VimCase {
  before: string;                 // cursor-marker string (editor starts in INSERT)
  keys: string;                   // DSL notation
  after: string;                  // cursor-marker string
  mode?: VimMode;                 // optional: assert final mode
  name?: string;                  // optional: overrides the auto-generated case name
}
// Register/linewise/undo-depth are deliberately NOT facets here — they are
// asserted behaviorally (see the notes below), never via editor internals.
```

Notes on observing register and undo **without any test-only source seam** —
tests never reach into `#register` / `#undoStack`; they assert the observable
contract:

- **Register**: the register's only observable effect is paste, so a register
  assertion *is* a paste assertion. Yank/delete, then paste, and check the
  buffer — exactly how a vim user verifies a register, and how `smoke.ts`
  62–73 already do it. Charwise vs linewise falls out of *where* the paste
  lands (inline after the cursor vs on its own new line), so both flavors are
  covered by the resulting `after` string. No getter, no probe, no source change.
  ```ts
  vt({ before: "|foo bar", keys: "yiwwP", after: "foo |foobar" }); // yiw captured "foo"
  vt({ before: "|foo\nbar", keys: "yyp",  after: "foo\n|foo\nbar" }); // linewise paste
  ```
- **Undo/redo granularity**: also observable — *how many `u` presses return to a
  known state* is the contract. "One command = one undo unit" is asserted by
  editing, pressing `u` once, and checking the buffer is fully restored (a
  second `u` then reaches the prior state; `<C-r>` re-applies). For these
  multi-step sequences use the imperative `send()`/`state()` API instead of a
  single `before→after` row:
  ```ts
  const h = createHarness();
  h.send("ithe quick<Esc>0dw");     // insert, then one NORMAL command (dw)
  const afterEdit = h.state();
  h.send("u");                       // ONE undo must restore the whole dw
  expect(h.state()).toBe("the |quick");
  h.send("<C-r>");                   // redo re-applies the same single unit
  expect(h.state()).toBe(afterEdit);
  ```
  INSERT-per-keystroke granularity, paste-as-one-unit, and redo-stack clearing
  are all expressed the same way: a sequence of `send()`s with `state()`
  checks between them. `HostEffects.dispatched` (captured `runExCommand` lines)
  covers ex dispatch without touching internals either.

Seeding `before`: `setText(state.text)` then move to `(line,col)` via the same
public `moveToMessageStart`/arrow replay the editor uses (a
`moveTo(line,col)` helper in the harness). The editor starts in INSERT; cases
that begin in NORMAL prefix their `before` semantics by sending `<Esc>` — or the
harness exposes `send` and the case `keys` simply start with `<Esc>` as the
tests do today. Convention: **`keys` always starts from INSERT mode at the marked
cursor** (matching a fresh editor), so a NORMAL-mode case begins `"<Esc>…"`. This
keeps one unambiguous starting contract.

## 7. Coverage matrix

Coverage is driven off the README key tables so every documented key has at least
one case. Each row below becomes a `describe` with ≥1 `vt` case (happy path +
boundaries: BOF/EOF, empty line, count, no-op).

- **Mode transitions**: `Esc`/`Ctrl+[`, `i a I A o O`, `v V`, `:`; double-Esc
  passthrough to host; unmapped NORMAL key swallowed.
- **Motions**: `h l j k` (+count), `w W b B e E` (+count, cross-line), `0 ^ $`,
  `{ }` (+count), `f F t T` + `; ,` (+count, not-found no-op), `%`, `gg G`,
  `{count}gg` / `{count}G`.
- **Operators**: `d c y` × every motion above; `dd cc yy` (+count), `D C`,
  `dj dk cj ck yj yk`, `dgg dG cG`, `x X s` (+count), `r{char}`,
  `cw`/`cW` special-case (behaves as `ce` on non-blank, as `w` on blank).
- **Text objects**: `i`/`a` × `w W " ' `` ( ) [ ] { } b B` through `d c y`
  (` diw ciw daw`, `ci" ci' di( da{ yi[`, nested/unbalanced/no-match).
- **Visual**: `v`/`V` enter, motions resize, `o`/`O` swap, `d x c s y Y`,
  `D X C S` force-linewise, `p P` replace-selection, `v`↔`V` switch, `Esc` cancel.
- **Registers/paste**: `yy p`/`P`, `yw p`, `yiw P`, `dd p`, `x p` transpose,
  `{count}p`, linewise vs charwise cursor rest position, empty-register no-op,
  yank does not disturb undo.
- **Undo/redo**: `u`/`{count}u`, `Ctrl+r`/`{count}Ctrl+r`, one NORMAL command =
  one unit (incl. multi-line `dd`/`dj`/`dG`), INSERT undoes per keystroke, paste
  undoes as one unit, new edit clears redo, multi-step timeline order.
- **EX**: open/cancel/backspace, `:q`/`:qa`/… on empty vs dirty prompt, `!` force,
  `:{name}` known dispatch + draft restore, args after first space, `:!cmd`/`:!!`,
  reserved names notify, prototype-chain names not treated as quit/reserved,
  unknown notifies, pasted newline never auto-submits, ex never touches undo.
- **Unicode/grapheme** (`unicode.test.ts`): emoji (`👨‍👩‍👧`), combining marks,
  CJK width, across `x`, `w/e/b`, `dw`, `ci"`, visual, paste — the bridge and
  motions are grapheme-aware and this must survive the refactor.

A short checklist in `test/README` (or a comment header) maps each README key to
its owning file, so a reviewer can confirm nothing is uncovered.

## 8. Fixtures (`test/support/fixtures.ts`)

Shared sample buffers so unicode/multiline cases are consistent and named:

```ts
export const SINGLE = "the quick brown fox";
export const MULTILINE = "first line\nsecond line\nthird line";
export const PARAGRAPHS = "a\nb\n\nc\nd\n\ne";      // for { } motions
export const BRACKETS = "foo(bar[baz]qux)end";      // for % and text objects
export const EMOJI = "a👨‍👩‍👧b🎉c";                    // grapheme clusters
export const CJK = "日本語 テスト です";
export const COMBINING = "e\u0301fg";               // é as e + combining acute
```

## 9. Optional property-based layer (fast-check)

Additive, in its own file (`test/vim/bridge.props.test.ts`), gated so the base
suite stays dependency-free. High-value invariants for the pure layer:

- `absToLineCol(lines, lineColToAbs(lines, l, c)) === {l, c}` for all in-range
  `(l, c)` — the bridge round-trip. A refactor of offset math must keep this.
- `graphemeSteps(line, a, b) === graphemeSteps(line, b, a)` (direction-agnostic).
- `orderVisualEndpoints` always returns start ≤ end regardless of input order.
- Word motion monotonicity: `w` never moves backward, `b` never forward.

Adopt only if these catch bugs the table cases miss; otherwise the table suite is
sufficient and dependency-free.

## 10. Vendored-file drift strategy

`src/vim/*` carry a "DO NOT edit; re-vendor from upstream" header. The Layer-1
tests are the contract those files must satisfy for `modal-editor.ts` to work. On
re-vendor:

1. Replace the file(s).
2. Run `bun test test/vim` — failures pinpoint exactly which upstream behavior
   changed under us.
3. If a change is intentional, update the Layer-1 case *and* any Layer-2 case
   that depended on it, in the same commit, so the behavior delta is reviewable.

## 11. Tooling (as-built)

- `package.json` scripts: `typecheck` (`tsc --noEmit`), `test` (`bun test`),
  `test:cov` (`bun test --coverage`).
- `tsconfig.json` `include`: `src/**/*.ts`, `test/**/*.ts` — tests are
  typechecked by `bun run typecheck`.

## 12. Migration from `smoke.ts` (complete)

Clean cutover, done:

1. Built `test/support/*` (harness, keys, state, fixtures) and verified the DSL
   with `test/support/harness.test.ts`.
2. Ported every `smoke.ts` behavior into the layered suites (1–46 →
   `modes`/`motions`/`operators`/`text-objects`/`visual`/`undo`; 47–61 → `ex`
   and `widget`; 62–73 → `registers`), adding boundary + unicode coverage.
3. Confirmed parity: the new suite and `smoke.ts` were both green together.
4. Deleted `smoke.ts` and dropped the `smoke` script — single source of truth,
   no dual maintenance.

## 13. Conventions for adding tests with new features

When a feature lands (e.g. named registers, `.` repeat):

1. Add its keys to the DSL (`keys.ts`) if new special bytes are involved.
2. Add a `describe` + `vt.each` table in the owning `test/editor/*.ts` (or a new
   file for a whole new area), with happy path + boundaries + no-op.
3. If it rests on new pure logic in `src/vim/*`, add Layer-1 cases first (TDD:
   the pure contract, then the editor behavior).
4. Update the §7 coverage checklist so the key is accounted for.

This keeps "add a test" at the cost of one table row for most changes, which is
the whole point of the harness.
