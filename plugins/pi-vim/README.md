# pi-vim

Vim-style modal editing in the omp prompt box. `Esc` drops the prompt into
NORMAL mode for motions and edits; `i`/`a`/`o`/… return to INSERT; `v`/`V`
start a VISUAL selection. INSERT mode is the stock omp editor, unchanged
(typing, paste, history, autocomplete, submit).

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
(`NORMAL` / `INSERT` / `VISUAL` / `V-LINE`, like Pi's TUI) and, on terminals
that honor DECSCUSR, as a steady block (NORMAL and VISUAL) or blinking bar
(INSERT) cursor.

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

## NORMAL-mode keys

Motions accept a `{count}` prefix (e.g. `3j`, `12l`).

| Key | Action |
| --- | --- |
| `h` `l` `j` `k` | Left / right / down / up |
| `w` `W` `b` `B` `e` `E` | word / WORD start-forward, back, end-forward |
| `0` `^` `$` | Line start / first non-blank / end |
| `{` `}` | Previous / next paragraph |
| `f` `F` `t` `T` `;` `,` | Char find forward/back, till, and repeat |
| `%` | Jump to matching `()` `[]` `{}` |
| `gg` `G` `{count}gg` `{count}G` | First line / last line / absolute line |
| `x` | Delete char(s) under cursor |
| `r{char}` | Replace char under cursor |
| `s` | Delete char and enter INSERT |
| `dd` `cc` `{count}dd` | Delete / change whole line(s) |
| `D` `C` | Delete / change to end of line |
| `d{motion}` `c{motion}` | Operator + any motion above (`dw`, `d$`, `df.`, `d%`, `dj`, …) |
| `d{i,a}{obj}` `c{i,a}{obj}` | Text objects `w W " ' \`\` ( ) [ ] { } b B` (`ci"`, `daw`, `di(`) |
| `u` `{count}u` | Undo the last edit(s) |
| `Ctrl+r` `{count}Ctrl+r` | Redo the last undone edit(s) |

`Enter` still submits from NORMAL mode, and modified app chords (model cycle,
external editor, …) pass through untouched — except `Ctrl+r`, which is claimed
for vim redo. Any unmapped printable key in NORMAL mode is swallowed, so it
never leaks into the draft.

## VISUAL-mode keys

`v` starts a charwise selection, `V` a linewise one; the anchor stays put while
any NORMAL motion (`h`/`l`/`j`/`k`, `w`/`b`/`e`, `f{char}`, `%`, `gg`/`G`, …)
moves the other end. Both ends are inclusive.

| Key | Action |
| --- | --- |
| motions | Resize the selection (cursor end moves) |
| `o` | Swap which end of the selection is active |
| `d` `x` | Delete the selection → NORMAL |
| `c` `s` | Delete the selection → INSERT |
| `V` (in `v`) / `v` (in `V`) | Switch charwise ↔ linewise |
| `Esc` | Cancel the selection → NORMAL |

Yank/paste is not yet available (pi-vim has no registers), so `y` is inert in
VISUAL mode for now.

## How it works

The extension swaps omp's prompt editor for a `CustomEditor` subclass via
`ctx.ui.setEditorComponent(...)`. omp's base `Editor` keeps its buffer in a
hard-private field and exposes no cursor setter, so NORMAL mode never pokes
internal state. Instead it computes motion, operator, and text-object targets
as buffer offsets with pure, nvim-parity functions vendored from
[`lajarre/pi-vim`](https://github.com/lajarre/pi-vim) (`src/vim/`), then walks
the cursor to each target by replaying the editor's own arrow/delete key
sequences through `handleDraftEdit(...)`. `src/vim/bridge.ts` converts between
UTF-16 offsets and grapheme-step key counts, so line wrapping, grapheme
boundaries, and autocomplete dismissal all stay owned by the base editor. On
`session_shutdown` the default editor is restored.

Undo/redo is owned by pi-vim, not the base editor: the base `#applyUndo` pops
without capturing the replaced state (so it cannot redo) and snapshots once per
delete *call* (so a multi-key edit would undo one grapheme at a time). Instead
the editor snapshots the whole buffer before each change and restores via
`setText`. Granularity follows vim: a NORMAL command is one step (including
multi-line `dd` / `dj` / `dG`), INSERT typing undoes character by character,
and a paste undoes as a single unit.

The vendored files under `src/vim/` are copied verbatim (MIT) and are not
edited in place; refresh them by re-vendoring from upstream.

## Develop

```
bun install
bun run typecheck   # tsc --noEmit
bun run smoke       # headless mode/motion checks
```

## Scope

NORMAL, INSERT, VISUAL, and VISUAL-LINE modes with motions, char-find,
paragraph and matching-pair motions, `d`/`c` operators, text objects, visual
selections, and `u` / `Ctrl+r` undo/redo. Not implemented: an ex line (`:`),
registers / yank / paste, and `.` repeat. See
[`lajarre/pi-vim`](https://github.com/lajarre/pi-vim) (upstream Pi) for the
full-featured equivalent this borrows its motion logic from.
