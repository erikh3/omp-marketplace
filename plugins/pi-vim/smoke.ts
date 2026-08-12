import { ModalVimEditor, type VimMode } from "./src/modal-editor.ts";
import { ModeWidget } from "./src/mode-widget.ts";
import type { EditorTheme } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";

// Minimal EditorTheme stub. The smoke test never calls render(), so only
// borderColor is read (stored by the base Editor constructor); selectList and
// symbols are unreachable here. Cast once, with that reason, at this seam.
const theme = { borderColor: (s: string) => s } as unknown as EditorTheme;

function newEditor(): { ed: ModalVimEditor; modes: VimMode[] } {
	const ed = new ModalVimEditor(theme);
	const modes: VimMode[] = [];
	ed.onModeChange = (m) => modes.push(m);
	return { ed, modes };
}

// Type a string in INSERT mode (default), one char at a time.
function type(ed: ModalVimEditor, s: string): void {
	for (const ch of s) ed.handleInput(ch);
}

const ESC = "\x1b";
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.log(`FAIL  ${name}: got ${a}, want ${e}`);
	}
}

// 1. Default mode is INSERT; typing lands in the buffer.
{
	const { ed, modes } = newEditor();
	type(ed, "hello world");
	check("insert types text", ed.getText(), "hello world");
	check("starts in insert (no change events)", modes, []);
}

// 2. Esc -> NORMAL, then a printable key is swallowed (not inserted).
{
	const { ed, modes } = newEditor();
	type(ed, "abc");
	ed.handleInput(ESC);
	check("esc enters normal", ed.mode, "normal");
	check("mode change fired", modes, ["normal"]);
	ed.handleInput("x"); // in normal x deletes forward; cursor at end so no-op or deletes nothing
	check("normal swallows literal letters (no 'x' appended)", ed.getText().includes("x"), false);
}

// 3. NORMAL motions: 0 to line start, then 'i' inserts at start.
{
	const { ed } = newEditor();
	type(ed, "world");
	ed.handleInput(ESC);
	ed.handleInput("0"); // move to line start
	ed.handleInput("i"); // insert mode at start
	check("i after 0 enters insert", ed.mode, "insert");
	type(ed, "hello ");
	check("insert at line start", ed.getText(), "hello world");
}

// 4. 'x' deletes the character under the cursor. Put cursor on 'b' of "abc".
{
	const { ed } = newEditor();
	type(ed, "abc");
	ed.handleInput(ESC); // normal, cursor after 'c'
	ed.handleInput("0"); // line start -> on 'a'
	ed.handleInput("l"); // -> on 'b'
	ed.handleInput("x"); // delete 'b'
	check("x deletes char under cursor", ed.getText(), "ac");
}

// 5. 'A' appends at line end and enters insert.
{
	const { ed } = newEditor();
	type(ed, "foo");
	ed.handleInput(ESC);
	ed.handleInput("0"); // go to start so we prove A jumps to end
	ed.handleInput("A");
	check("A enters insert", ed.mode, "insert");
	type(ed, "bar");
	check("A appends at line end", ed.getText(), "foobar");
}

// 6. 'dw' deletes a word forward.
{
	const { ed } = newEditor();
	type(ed, "one two three");
	ed.handleInput(ESC);
	ed.handleInput("0"); // start, on 'o' of one
	ed.handleInput("d");
	ed.handleInput("w"); // delete "one " word
	check("dw deletes word forward", ed.getText(), "two three");
}

// 7. count prefix: '3l' moves right 3, then 'x' deletes the 4th char.
{
	const { ed } = newEditor();
	type(ed, "abcdef");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("3");
	ed.handleInput("l"); // cursor from 'a' -> 'd'
	ed.handleInput("x"); // delete 'd'
	check("count 3l then x deletes 4th char", ed.getText(), "abcef");
}

// 8. 'o' opens a line below and enters insert.
{
	const { ed } = newEditor();
	type(ed, "line1");
	ed.handleInput(ESC);
	ed.handleInput("o");
	check("o enters insert", ed.mode, "insert");
	type(ed, "line2");
	check("o opens line below", ed.getText(), "line1\nline2");
}

// 9. 'D' deletes to end of line from cursor.
{
	const { ed } = newEditor();
	type(ed, "keep drop");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("l");
	ed.handleInput("l");
	ed.handleInput("l");
	ed.handleInput("l"); // cursor at index 4 (the space)
	ed.handleInput("D"); // delete from cursor to EOL
	check("D deletes to line end", ed.getText(), "keep");
}

// 10. Esc in normal mode is idempotent (stays normal, resets pending).
{
	const { ed } = newEditor();
	type(ed, "x");
	ed.handleInput(ESC);
	ed.handleInput(ESC);
	check("double esc stays normal", ed.mode, "normal");
}

// 11. Mode widget renders the label right-aligned and updates on mode change.
{
	const themeStub = { fg: (_c: string, s: string) => s } as unknown as Theme;
	const widget = new ModeWidget("insert", themeStub);
	const insertLine = widget.render(20)[0] ?? "";
	check("widget right-aligns (fills width)", insertLine.length, 20);
	check("widget ends with INSERT label", insertLine.endsWith(" INSERT "), true);
	check("widget left-pads with spaces", insertLine.startsWith("  "), true);
	widget.setMode("normal");
	const normalLine = widget.render(20)[0] ?? "";
	check("widget switches to NORMAL", normalLine.includes("NORMAL"), true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
