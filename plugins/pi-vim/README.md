# pi-vim

Vim-style modal editing in the omp prompt box. `Esc` drops the prompt into
NORMAL mode for motions and edits; `i`/`a`/`o`/… return to INSERT. INSERT mode
is the stock omp editor, unchanged (typing, paste, history, autocomplete,
submit).

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

The active mode shows as a right-aligned indicator below the editor
(`NORMAL` / `INSERT`, like Pi's TUI) and, on terminals that honor DECSCUSR, as
a steady block (NORMAL) or blinking bar (INSERT) cursor.

| From | Key | Action |
| --- | --- | --- |
| INSERT | `Esc` / `Ctrl+[` | → NORMAL |
| NORMAL | `i` | Insert at cursor |
| NORMAL | `a` | Insert after cursor |
| NORMAL | `I` | Insert at line start |
| NORMAL | `A` | Insert at line end |
| NORMAL | `o` | Open line below + insert |
| NORMAL | `O` | Open line above + insert |

## NORMAL-mode keys

Motions accept a `{count}` prefix (e.g. `3j`, `12l`).

| Key | Action |
| --- | --- |
| `h` `l` `j` `k` | Left / right / down / up |
| `w` `b` | Word forward / back |
| `0` `$` | Line start / end |
| `gg` `G` | Buffer start / end |
| `x` | Delete char under cursor |
| `dd` | Delete current line's text |
| `dw` | Delete word forward (through trailing whitespace) |
| `d$` `D` | Delete to end of line |
| `dl` | Delete char (operator form of `x`) |

`Enter` still submits from NORMAL mode, and modified app chords (model cycle,
history search, external editor, …) pass through untouched. Any unmapped
printable key in NORMAL mode is swallowed, so it never leaks into the draft.

## How it works

The extension swaps omp's prompt editor for a `CustomEditor` subclass via
`ctx.ui.setEditorComponent(...)`. omp's base `Editor` keeps its buffer in a
hard-private field, so NORMAL-mode motions don't poke internal state — they
replay the editor's own key sequences through `handleDraftEdit(...)`, leaving
grapheme boundaries, line wrapping, undo, and autocomplete dismissal to the
base editor. On `session_shutdown` the default editor is restored.

## Develop

```
bun install
bun run typecheck   # tsc --noEmit
bun run smoke       # headless mode/motion checks
```

## Scope

Deliberately a focused MVP: NORMAL/INSERT modes with core motions and a few
operators. Not implemented: VISUAL mode, an ex line (`:`), registers/yank/paste,
`f`/`t` char-find, text objects (`ci"`, `da{`), `.` repeat, `u`/`Ctrl+r` vim
undo, and `{count}G` to an absolute line. See `lajarre/pi-vim` (upstream Pi) for
the full-featured equivalent.
