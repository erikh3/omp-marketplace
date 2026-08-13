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
| `yy` `Y` `{count}yy` | Yank whole line(s) into the unnamed register |
| `y{motion}` `y{i,a}{obj}` | Yank a range / text object (`yw`, `y$`, `yiw`, `ya"`, `yj`) |
| `p` `P` `{count}p` | Paste after / before the cursor (charwise inline, linewise on new line(s)) |
| `u` `{count}u` | Undo the last edit(s) |
| `Ctrl+r` `{count}Ctrl+r` | Redo the last undone edit(s) — or open omp's prompt history (see below) |

`Enter` still submits from NORMAL mode, and modified app chords (model cycle,
external editor, …) pass through untouched. Any unmapped printable key in
NORMAL mode is swallowed, so it never leaks into the draft.

### `Ctrl+r`: redo vs. prompt history

`Ctrl+r` is normally omp's prompt-history search, but vim also binds it to
redo. pi-vim keeps both by choosing based on the prompt and the vim undo
timeline:

| Prompt | Vim history | `Ctrl+r` does |
| --- | --- | --- |
| has text | — | **Redo** the last undone edit(s) |
| empty | present | **Redo** (a no-op when the redo stack is empty) |
| empty | none | **Prompt history** — forwarded to omp's `Ctrl+r` search |

So on a fresh empty prompt `Ctrl+r` opens prompt history as usual, and it only
redoes while you have a draft or an active undo timeline. Submitting with
`Enter` ends the draft and clears pi-vim's undo timeline, so once the prompt is
empty again `Ctrl+r` returns to opening prompt history.

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
and a paste undoes as a single unit. Submitting with `Enter` clears this
timeline (the draft is gone), which is what lets `Ctrl+r` fall back to omp's
prompt-history search on the next empty prompt.

The vendored files under `src/vim/` are copied verbatim (MIT) and are not
edited in place; refresh them by re-vendoring from upstream.

## Develop

```
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit + integration suite (test/)
```

## Scope

NORMAL, INSERT, VISUAL, and VISUAL-LINE modes plus an EX command line, with
motions, char-find, paragraph and matching-pair motions, `d`/`c`/`y` operators,
text objects, visual selections, yank/paste through vim's unnamed register,
`u` / `Ctrl+r` undo/redo, and `:` command dispatch. Not implemented: named
registers, the system clipboard, and `.` repeat. See
[`lajarre/pi-vim`](https://github.com/lajarre/pi-vim) (upstream Pi) for the
full-featured equivalent this borrows its motion logic from.
