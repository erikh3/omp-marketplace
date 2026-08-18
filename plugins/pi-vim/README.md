# pi-vim

Vim-style modal editing in the omp prompt box. `Esc` drops the prompt into
NORMAL mode for motions and edits; `i`/`a`/`o`/… return to INSERT; `v`/`V`
start a VISUAL selection; `:` opens an EX command line into omp's palette.
INSERT mode is the stock omp editor, unchanged (typing, paste, history,
autocomplete, submit).

## Install

From this marketplace:

```
/marketplace install pi-vim@erikh3-omp-marketplace
```

Then restart omp (extension modules load at startup). For local development,
point omp at a working copy instead of the cached install:

```
omp plugin link ./plugins/pi-vim
```

## Modes

The active mode shows as a right-aligned indicator below the editor (like Pi's
TUI): a filled block whose color tracks the mode. INSERT uses the muted border
tone, NORMAL the accent border, VISUAL / V-LINE the custom-message color, and
EX the warning color (all from the active theme, matching upstream
`lajarre/pi-vim`). On terminals that honor DECSCUSR the cursor also follows the
mode: a steady block (NORMAL, VISUAL, and EX) or a blinking bar (INSERT).

| From | Key | Action |
| --- | --- | --- |
| INSERT | `Esc` / `Ctrl+[` | → NORMAL |
| NORMAL | `i` | Insert at cursor |
| NORMAL | `a` | Insert after cursor |
| NORMAL | `I` | Insert at line start |
| NORMAL | `A` | Insert at line end |
| NORMAL | `o` | Open line below + insert |
| NORMAL | `O` | Open line above + insert |
| NORMAL | `v` | → VISUAL (charwise) |
| NORMAL | `V` | → VISUAL-LINE (linewise) |
| VISUAL | `Esc` / `v` | → NORMAL |
| VISUAL-LINE | `Esc` / `V` | → NORMAL |
| NORMAL | `:` | → EX (execute command line) |
| EX | `Enter` | Run the command |
| EX | `Esc` | Cancel EX |

## NORMAL-mode keys

Motions accept a `{count}` prefix (e.g. `3j`, `12l`).

| Key | Action |
| --- | --- |
| `h` `l` `j` `k` | Left / right / down / up |
| `←` `→` `↓` `↑` | Same as `h` / `l` / `j` / `k` (on an empty prompt they pass through to omp instead — double-tap `←` opens the agent hub, `↑`/`↓` walk prompt history) |
| `w` `W` `b` `B` `e` `E` | word / WORD start-forward, back, end-forward |
| `0` `^` `$` | Line start / first non-blank / end |
| `{` `}` | Previous / next paragraph |
| `f` `F` `t` `T` `;` `,` | Char find forward/back, till, and repeat |
| `%` | Jump to matching `()` `[]` `{}` |
| `gg` `G` `{count}gg` `{count}G` | First line / last line / absolute line |
| `_` `{count}_` | First non-blank of the current / counted line-down |
| `gM` `{count}gM` | Halfway across the line's text (`{count}` = percentage, 1–100) |
| `x` `{count}x` | Delete char(s) under the cursor forward |
| `X` `{count}X` | Delete char(s) before the cursor (clamped at line start) |
| `r{char}` | Replace char under cursor |
| `s` | Delete char and enter INSERT |
| `S` `{count}S` | Change whole line(s) and enter INSERT (same as `cc`) |
| `dd` `cc` `{count}dd` | Delete / change whole line(s) |
| `D` `C` | Delete / change to end of line |
| `J` `{count}J` | Join line(s); single space at the boundary, leading blanks stripped |
| `gJ` `{count}gJ` | Join line(s) without whitespace normalization |
| `d{motion}` `c{motion}` | Operator + any motion above (`dw`, `d$`, `df.`, `d%`, `dj`, …) |
| `d{i,a}{obj}` `c{i,a}{obj}` | Text objects `w W " ' \`\` ( ) [ ] { } b B` (`ci"`, `daw`, `di(`) |
| `yy` `Y` `{count}yy` | Yank whole line(s) into the unnamed register |
| `y{motion}` `y{i,a}{obj}` | Yank a range / text object (`yw`, `y$`, `yiw`, `ya"`, `yj`) |
| `p` `P` `{count}p` | Paste after / before the cursor (charwise inline, linewise on new line(s)) |
| `u` `{count}u` | Undo the last edit(s) |
| `Ctrl+r` `{count}Ctrl+r` | Redo the last undone edit(s) — or open omp's prompt history (see below) |
| `.` `{count}.` | Repeat the last change (`{count}` overrides the stored count) |

`Enter` still submits from NORMAL mode, and modified app chords (model cycle,
external editor, …) pass through untouched. Any unmapped printable key in
NORMAL mode is swallowed, so it never leaks into the draft.

### `Ctrl+r`: redo vs. prompt history

`Ctrl+r` is normally omp's prompt-history search, but vim also binds it to
redo. pi-vim keeps both with one rule: **if there is an undone edit to
re-apply, redo it; otherwise there is nothing to restore, so `Ctrl+r` falls
through to omp's prompt-history search.**

| Redo stack | `Ctrl+r` does |
| --- | --- |
| has an undone edit | **Redo** the last undone edit(s) (`{count}` supported) |
| empty | **Prompt history** — forwarded to omp's `Ctrl+r` search |

This holds regardless of the buffer contents: on a fresh prompt (nothing
undone) `Ctrl+r` opens prompt history as usual, and after you redo everything
back it opens prompt history again. Submitting with `Enter` ends the draft and
clears pi-vim's undo timeline, so a prior draft's undone edit never leaks a
redo into the next prompt.

## VISUAL-mode keys

`v` starts a charwise selection, `V` a linewise one; the anchor stays put while
any NORMAL motion (`h`/`l`/`j`/`k`, `w`/`b`/`e`, `f{char}`, `%`, `gg`/`G`, …)
moves the other end. Both ends are inclusive.

| Key | Action |
| --- | --- |
| motions | Resize the selection (cursor end moves) |
| `o` | Swap which end of the selection is active |
| `d` `x` | Delete the selection (into the register) → NORMAL |
| `c` `s` | Delete the selection (into the register) → INSERT |
| `y` `Y` | Yank the selection into the register → NORMAL |
| `p` `P` | Replace the selection with the register |
| `V` (in `v`) / `v` (in `V`) | Switch charwise ↔ linewise |
| `Esc` | Cancel the selection → NORMAL |

> [!NOTE]
> The selection is **not** highlighted. omp's editor exposes no per-column
> text-decoration hook (its only styling seam, `decorateText`, receives a whole
> logical line with no cursor/anchor index), so pi-vim cannot paint the span.
> The selection is tracked internally from the anchor to the cursor: watch the
> block cursor and the `VISUAL` / `V-LINE` footer to see where it runs, then the
> operator (`d`, `c`, …) applies to anchor→cursor. Upstream `lajarre/pi-vim` is
> the same — its own renderer only syncs the cursor shape and mode label.

Deletes, changes, and yanks all fill vim's unnamed register, so `dd`/`yy` then
`p`, visual `y` then `p`, and `x` then `p` (transpose) all work.

## EX (execute) mode

`:` in NORMAL opens a Vim-style command line, shown in the footer as `EX :cmd_`.
`Enter` runs it, `Esc` cancels, `Backspace` deletes (on a bare `:` it exits EX).
This is a bridge to omp's command palette, not real Vim ex semantics: `:name` is
exactly typing `/name` and pressing Enter.

| Command | Action |
| --- | --- |
| `:q` `:qa` `:quit` `:qall` `:quitall` | Quit the session — only when the prompt is empty/whitespace |
| `:q!` (and the `!` forms above) | Force-quit even with a non-empty prompt |
| `:{name}` | Run the omp slash command `/{name}` (builtins + `pi.getCommands()`) |
| `:{name} {args}` | Run `/{name} {args}` (everything after the first space) |
| `:!{cmd}` | Run `{cmd}` in omp's shell (`!{cmd}`); `:!!{cmd}` runs it out of context |

The composed prompt is snapshotted before a dispatch and restored after, so a
command never eats your draft. A pasted newline never auto-submits — only a
typed `Enter` does. Reserved Vim names (`s`, `g`, `w`, `d`, …) are held for
future line-address support and notify instead of dispatching; an unknown name
notifies rather than reaching the model. EX editing never touches the undo
timeline.

## System clipboard

Deletes, changes, and yanks fill vim's unnamed register and, by default, mirror
to the OS clipboard; `p`/`P` read the OS clipboard first (falling back to the
internal shadow when the last write was policy-skipped or a read is
unavailable). The mirror is governed by `clipboardMirror` (see below):

| `clipboardMirror` | Mirrors to the OS clipboard |
| --- | --- |
| `all` (default) | Every unnamed write — yanks and deletes/changes |
| `yank` | Yanks only; deletes/changes stay in the internal shadow |
| `never` | Nothing; the shadow is authoritative |

The OS read is asynchronous, so pi-vim refreshes a read cache on entering
NORMAL and after each mirror write; a `p` reads that cache. Every clipboard
access is best-effort — a failure never breaks editing.

## Configuration

omp's settings schema has no `piVim.*` namespace, so pi-vim reads its own
`pi-vim.json`: a global file in the agent dir (`~/.omp/agent/pi-vim.json`),
overlaid by a project `.omp/pi-vim.json`. All keys are optional; a missing,
malformed, or unknown value falls back to the default. The project file
overrides the global per top-level key, **except** `modeChange` and
`exCommand.copyInputToClipboard`, which are user-global only (they wield
arbitrary shell / clipboard-exfiltration power, so a checked-in project file
cannot enable them).

Default-equivalent `pi-vim.json`:

```json
{
  "clipboardMirror": "all",
  "exCommand": { "piDispatch": true, "copyInputToClipboard": false },
  "modeColors": {
    "normal": "borderAccent",
    "insert": "borderMuted",
    "visual": "customMessageLabel",
    "ex": "warning"
  },
  "labelSync": { "normal": "mode", "insert": "mode", "visual": "mode", "ex": "mode" },
  "modeChange": {}
}
```

| Key | Effect |
| --- | --- |
| `clipboardMirror` | OS-clipboard mirror policy (`all` / `yank` / `never`) |
| `exCommand.piDispatch` | `false` makes the ex line quit-only (`:name` no longer dispatches `/name`) |
| `exCommand.copyInputToClipboard` | `true` copies the composed prompt to the OS clipboard before each ex dispatch (global-only) |
| `modeColors` | Theme foreground token per mode for the footer indicator + EX line |
| `labelSync` | Per-mode footer paint policy (`mode` = mode color, `host` = host color) |
| `modeChange.insert` / `modeChange.normal` | Shell command run on entering INSERT / any non-INSERT editing mode (global-only) |

`modeChange` is typically used for automatic IME switching — point it at any CLI
that changes your input method (e.g. `im-select`). The command runs
asynchronously via your shell (`$SHELL -c`), fire-and-forget; stdio is discarded
and failures are silenced so editing never blocks.

> `borderSync` (per-mode editor **border** color) from upstream `lajarre/pi-vim`
> is intentionally unsupported: omp's extension UI exposes no per-mode border
> setter (only the whole active theme). `labelSync` / `modeColors` cover the
> footer indicator, which pi-vim fully owns.

## For other extensions

pi-vim emits `pi-vim:mode-change` on `pi.events` with `{ mode, previousMode }`
on every real transition, and the editor exposes `getMode()` returning
`"normal"` / `"insert"` / `"visual"` / `"visual-line"` so a wrapping extension
can tell the two visual sub-modes apart.

## How it works

The extension swaps omp's prompt editor for a `CustomEditor` subclass via
`ctx.ui.setEditorComponent(...)`. omp's base `Editor` keeps its buffer in a
hard-private field and exposes no cursor setter, so NORMAL mode never pokes
internal state. Instead it computes motion, operator, and text-object targets
as buffer offsets with pure, nvim-parity functions vendored from
[`lajarre/pi-vim`](https://github.com/lajarre/pi-vim) (`src/vim/`), then walks
the cursor to each target by replaying the editor's own arrow/delete key
sequences through `handleDraftEdit(...)`. `src/host/keystroke-bridge.ts`
converts between UTF-16 offsets and grapheme-step key counts, so line wrapping,
grapheme boundaries, and autocomplete dismissal all stay owned by the base
editor. On `session_shutdown` the default editor is restored.

Undo/redo is owned by pi-vim, not the base editor: the base `#applyUndo` pops
without capturing the replaced state (so it cannot redo) and snapshots once per
delete *call* (so a multi-key edit would undo one grapheme at a time). Instead
the editor snapshots the whole buffer before each change and restores via
`setText`. Granularity follows vim: a NORMAL command is one step (including
multi-line `dd` / `dj` / `dG`), INSERT typing undoes character by character,
and a paste undoes as a single unit. `Ctrl+r` redoes while the redo stack has
an undone edit and otherwise forwards to omp's prompt-history search; a submit
(`Enter`) clears this timeline so a prior draft's undone edit never leaks a
redo into the next prompt.

The vendored files under `src/vim/` are copied verbatim from `lajarre/pi-vim`
under the MIT License (see `src/vim/LICENSE`) and are not edited in place;
refresh them by re-vendoring from upstream.

## Develop

```
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit + integration suite (test/)
```

## Scope

NORMAL, INSERT, VISUAL, and VISUAL-LINE modes plus an EX command line, with
motions, char-find, paragraph and matching-pair motions, `d`/`c`/`y` operators,
text objects, visual selections, yank/paste through vim's unnamed register with
an OS-clipboard mirror, `u` / `Ctrl+r` undo/redo, `.` repeat, `J`/`gJ`,
`_`/`gM`, and `:` command dispatch. Configurable via `pi-vim.json`. Not
implemented: named registers, macros, and search (`/`, `n`). See
[`lajarre/pi-vim`](https://github.com/lajarre/pi-vim) (upstream Pi) for the
full-featured equivalent this borrows its motion logic from.
