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

// 12. Word motions e/b and operator cw.
{
	const { ed } = newEditor();
	type(ed, "foo bar baz");
	ed.handleInput(ESC); // normal, cursor on last char
	ed.handleInput("0"); // line start (on 'f')
	ed.handleInput("e"); // end of "foo" -> col 2
	check("e lands on word end", ed.getCursor().col, 2);
	ed.handleInput("w"); // start of "bar" -> col 4
	check("w lands on next word start", ed.getCursor().col, 4);
	ed.handleInput("b"); // back to start of "foo" -> col 0
	check("b lands on prev word start", ed.getCursor().col, 0);
}

// 13. cw changes a word and enters INSERT (vim cw == ce on a word).
{
	const { ed, modes } = newEditor();
	type(ed, "foo bar");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("c");
	ed.handleInput("w"); // change "foo" (through its end), keep the space
	check("cw enters insert", modes.at(-1), "insert");
	type(ed, "XY");
	check("cw replaced the word", ed.getText(), "XY bar");
}

// 14. df{char}: delete forward through the target char, inclusive.
{
	const { ed } = newEditor();
	type(ed, "abcdef");
	ed.handleInput(ESC);
	ed.handleInput("0"); // on 'a'
	ed.handleInput("d");
	ed.handleInput("f");
	ed.handleInput("d"); // delete "abcd" (a..d inclusive)
	check("df char deletes inclusive", ed.getText(), "ef");
}

// 15. t{char} then ; repeats the find.
{
	const { ed } = newEditor();
	type(ed, "a.b.c.d");
	ed.handleInput(ESC);
	ed.handleInput("0"); // on 'a'
	ed.handleInput("t");
	ed.handleInput("."); // stop before first '.', col 0 -> 0 (already before)
	check("t stops before char", ed.getCursor().col, 0);
	ed.handleInput(";"); // repeat: next '.' region, stop before it
	check("; repeats t past first", ed.getCursor().col, 2);
}

// 16. Text object ci" changes inside quotes.
{
	const { ed } = newEditor();
	type(ed, 'say "hi" ok');
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("f");
	ed.handleInput("i"); // cursor onto 'i' inside quotes
	ed.handleInput("c");
	ed.handleInput("i");
	ed.handleInput('"'); // change inside quotes
	type(ed, "yo");
	check('ci" replaces inside quotes', ed.getText(), 'say "yo" ok');
}

// 17. di( deletes inside parentheses.
{
	const { ed } = newEditor();
	type(ed, "f(a, b)");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("l");
	ed.handleInput("l"); // onto 'a'
	ed.handleInput("d");
	ed.handleInput("i");
	ed.handleInput("(");
	check("di( empties parens", ed.getText(), "f()");
}

// 18. gg / G across lines, and dd is linewise.
{
	const { ed } = newEditor();
	type(ed, "one\ntwo\nthree");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // to line 0
	check("gg goes to first line", ed.getCursor().line, 0);
	ed.handleInput("G"); // to last line
	check("G goes to last line", ed.getCursor().line, 2);
	ed.handleInput("d");
	ed.handleInput("d"); // delete last line (linewise, joins with preceding \n)
	check("dd removes the line", ed.getText(), "one\ntwo");
}

// 19. 2dd deletes two lines.
{
	const { ed } = newEditor();
	type(ed, "a\nb\nc\nd");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("2");
	ed.handleInput("d");
	ed.handleInput("d"); // delete lines 0..1
	check("2dd deletes two lines", ed.getText(), "c\nd");
}

// 20. r replaces the char under the cursor without leaving NORMAL.
{
	const { ed, modes } = newEditor();
	type(ed, "cat");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("r");
	ed.handleInput("b"); // "cat" -> "bat"
	check("r replaces char", ed.getText(), "bat");
	check("r stays in normal", modes.at(-1), "normal");
}

// 21. % jumps to the matching bracket.
{
	const { ed } = newEditor();
	type(ed, "x(y)z");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("l"); // onto '('
	check("cursor on open paren", ed.getCursor().col, 1);
	ed.handleInput("%"); // jump to ')'
	check("% jumps to match", ed.getCursor().col, 3);
}

// 22. D does not leave the operator pending: a following motion is not eaten.
{
	const { ed } = newEditor();
	type(ed, "foo\nbar");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0, first non-blank
	ed.handleInput("D"); // delete "foo" -> "\nbar"
	check("D deletes to line end", ed.getText(), "\nbar");
	ed.handleInput("j"); // must be a plain motion, NOT dj
	check("motion after D is not eaten", ed.getText(), "\nbar");
}

// 23. dF is exclusive of the cursor grapheme (backward char-find operator).
{
	const { ed } = newEditor();
	type(ed, "abXcd");
	ed.handleInput(ESC); // cursor on last char 'd'
	ed.handleInput("d");
	ed.handleInput("F");
	ed.handleInput("X"); // delete [X, d) -> keep 'ab' + 'd'
	check("dF is cursor-exclusive", ed.getText(), "abd");
}

// 24. cj changes two lines into one empty line and enters INSERT.
{
	const { ed, modes } = newEditor();
	type(ed, "aaa\nbbb\nccc");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("c");
	ed.handleInput("j"); // change lines 0..1
	check("cj enters insert", modes.at(-1), "insert");
	type(ed, "Z");
	check("cj collapses two lines", ed.getText(), "Z\nccc");
}

// 25. 2cc honors the count.
{
	const { ed } = newEditor();
	type(ed, "aaa\nbbb\nccc");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g");
	ed.handleInput("2");
	ed.handleInput("c");
	ed.handleInput("c"); // change lines 0..1
	type(ed, "Z");
	check("2cc changes two lines", ed.getText(), "Z\nccc");
}

// 26. dG deletes from the current line to the last line (operator + G).
{
	const { ed } = newEditor();
	type(ed, "a\nb\nc");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("j"); // line 1
	ed.handleInput("d");
	ed.handleInput("G"); // delete lines 1..2
	check("dG deletes to last line", ed.getText(), "a");
}

// 27. cw on whitespace changes only the whitespace run, not the next word.
{
	const { ed } = newEditor();
	type(ed, "foo  bar");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("l");
	ed.handleInput("l");
	ed.handleInput("l"); // onto first space (col 3)
	ed.handleInput("c");
	ed.handleInput("w"); // change the whitespace run only
	type(ed, "_");
	check("cw on whitespace spares next word", ed.getText(), "foo_bar");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
