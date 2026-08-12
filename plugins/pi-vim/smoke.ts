import { ModalVimEditor, type VimMode } from "./src/modal-editor.ts";
import { ModeWidget } from "./src/mode-widget.ts";
import { visibleWidth, type EditorTheme } from "@oh-my-pi/pi-tui";
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

// 10. Esc in NORMAL: cancels a pending command (swallowed), else passes through
// to the host so a second Esc can interrupt the agent.
{
	const { ed } = newEditor();
	let interrupts = 0;
	ed.onEscape = () => {
		interrupts++;
	};
	type(ed, "x"); // buffer "x", INSERT
	ed.handleInput(ESC); // INSERT -> NORMAL (owned, no interrupt)
	check("first esc enters normal", ed.mode, "normal");
	check("first esc does not interrupt", interrupts, 0);
	ed.handleInput(ESC); // NORMAL, nothing pending -> passes through
	check("second esc stays normal", ed.mode, "normal");
	check("second esc interrupts host", interrupts, 1);

	// A pending command swallows Esc instead of forwarding it.
	ed.handleInput("d"); // operator pending
	ed.handleInput(ESC); // cancels the operator, swallowed
	check("esc cancels pending, no interrupt", interrupts, 1);
}

// 11. Mode widget renders the label right-aligned and updates on mode change.
{
	const themeStub = { fg: (_c: string, s: string) => s } as unknown as Theme;
	const widget = new ModeWidget("insert", themeStub);
	const insertLine = widget.render(20)[0] ?? "";
	check("widget right-aligns (fills width)", visibleWidth(insertLine), 20);
	check("widget contains INSERT label", insertLine.includes(" INSERT "), true);
	check("widget left-pads with spaces", insertLine.startsWith("  "), true);
	widget.setMode("normal");
	const normalLine = widget.render(20)[0] ?? "";
	check("widget switches to NORMAL", normalLine.includes("NORMAL"), true);
	widget.setMode("visual");
	check("widget shows VISUAL", (widget.render(20)[0] ?? "").includes(" VISUAL "), true);
	widget.setMode("visual-line");
	check("widget shows V-LINE", (widget.render(20)[0] ?? "").includes(" V-LINE "), true);
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

// 28. u undoes the last edit from NORMAL mode.
{
	const { ed } = newEditor();
	type(ed, "hello");
	ed.handleInput(ESC);
	ed.handleInput("x"); // delete 'o' -> "hell"
	check("x deleted last char", ed.getText(), "hell");
	ed.handleInput("u"); // undo the delete
	check("u restores the edit", ed.getText(), "hello");
}

// 29. dw + u restores the WHOLE word in one undo (not one char at a time).
{
	const { ed } = newEditor();
	type(ed, "foo bar baz");
	ed.handleInput(ESC);
	ed.handleInput("0"); // start of "foo"
	ed.handleInput("d");
	ed.handleInput("w"); // delete "foo " -> "bar baz"
	check("dw removed the word", ed.getText(), "bar baz");
	ed.handleInput("u"); // single undo restores the whole deletion
	check("u restores whole dw", ed.getText(), "foo bar baz");
}

// 30. {count}x + u restores all deleted chars in one undo.
{
	const { ed } = newEditor();
	type(ed, "abcdef");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("3");
	ed.handleInput("x"); // delete "abc" -> "def"
	check("3x removed three chars", ed.getText(), "def");
	ed.handleInput("u");
	check("u restores whole 3x", ed.getText(), "abcdef");
}

// 31. dd + u restores the whole line in one undo (multi-line linewise).
{
	const { ed } = newEditor();
	type(ed, "one\ntwo\nthree");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("d");
	ed.handleInput("d"); // delete "one\n" -> "two\nthree"
	check("dd removed the line", ed.getText(), "two\nthree");
	ed.handleInput("u"); // single undo restores it whole
	check("u restores whole dd", ed.getText(), "one\ntwo\nthree");
}

// 32. 2dd + u restores both lines in one undo.
{
	const { ed } = newEditor();
	type(ed, "a\nb\nc\nd");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g");
	ed.handleInput("2");
	ed.handleInput("d");
	ed.handleInput("d"); // delete lines 0..1 -> "c\nd"
	check("2dd removed two lines", ed.getText(), "c\nd");
	ed.handleInput("u");
	check("u restores whole 2dd", ed.getText(), "a\nb\nc\nd");
}

// 33. dj + u restores both lines in one undo (multi-line motion).
{
	const { ed } = newEditor();
	type(ed, "l1\nl2\nl3");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("d");
	ed.handleInput("j"); // delete lines 0..1 -> "l3"
	check("dj removed two lines", ed.getText(), "l3");
	ed.handleInput("u");
	check("u restores whole dj", ed.getText(), "l1\nl2\nl3");
}

// 34. dG + u restores the tail in one undo.
{
	const { ed } = newEditor();
	type(ed, "a\nb\nc");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("j"); // line 1
	ed.handleInput("d");
	ed.handleInput("G"); // delete lines 1..2 -> "a"
	check("dG removed the tail", ed.getText(), "a");
	ed.handleInput("u");
	check("u restores whole dG", ed.getText(), "a\nb\nc");
}

// 35. Ctrl+r redoes an undone change.
{
	const { ed } = newEditor();
	type(ed, "hello world");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("d");
	ed.handleInput("w"); // -> "world"
	check("dw deleted first word", ed.getText(), "world");
	ed.handleInput("u"); // -> "hello world"
	check("u undid the delete", ed.getText(), "hello world");
	ed.handleInput("\x12"); // Ctrl+r redo -> "world"
	check("ctrl+r redid the delete", ed.getText(), "world");
}

// 36. A new edit after undo clears the redo stack (vim semantics).
{
	const { ed } = newEditor();
	type(ed, "abcdef");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("x"); // -> "bcdef"
	ed.handleInput("u"); // -> "abcdef"
	ed.handleInput("x"); // new edit -> "bcdef" (redo of the first x is now gone)
	ed.handleInput("\x12"); // Ctrl+r: nothing to redo
	check("new edit clears redo", ed.getText(), "bcdef");
}

// 37. INSERT typing undoes character by character (not the whole session).
{
	const { ed } = newEditor();
	type(ed, "top");
	ed.handleInput(ESC);
	ed.handleInput("o"); // open line below, INSERT
	type(ed, "added");
	ed.handleInput(ESC);
	check("o added a line", ed.getText(), "top\nadded");
	ed.handleInput("u"); // one undo drops one typed char
	check("u drops one typed char", ed.getText(), "top\nadde");
	ed.handleInput("u");
	ed.handleInput("u"); // three chars gone total
	check("each u drops one char", ed.getText(), "top\nad");
	ed.handleInput("\x12"); // redo restores one char
	check("ctrl+r restores one char", ed.getText(), "top\nadd");
}

// 38. A paste undoes as a single unit (one bracketed-paste mutation).
{
	const { ed } = newEditor();
	ed.handleInput("\x1b[200~hello world\x1b[201~"); // paste in INSERT (default)
	check("paste landed", ed.getText(), "hello world");
	ed.handleInput(ESC);
	ed.handleInput("u"); // one undo removes the whole paste
	check("u removes whole paste", ed.getText(), "");
	ed.handleInput("\x12"); // redo restores the whole paste
	check("ctrl+r restores whole paste", ed.getText(), "hello world");
}

// 39. multi-step undo/redo walks the timeline in order.
{
	const { ed } = newEditor();
	type(ed, "w1 w2 w3");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("d");
	ed.handleInput("w"); // -> "w2 w3"
	ed.handleInput("d");
	ed.handleInput("w"); // -> "w3"
	check("two dw edits", ed.getText(), "w3");
	ed.handleInput("u"); // -> "w2 w3"
	ed.handleInput("u"); // -> "w1 w2 w3"
	check("two undos walk back", ed.getText(), "w1 w2 w3");
	ed.handleInput("\x12"); // -> "w2 w3"
	ed.handleInput("\x12"); // -> "w3"
	check("two redos walk forward", ed.getText(), "w3");
}

// 40. v enters VISUAL; Esc exits back to NORMAL.
{
	const { ed, modes } = newEditor();
	type(ed, "hello");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("v");
	check("v enters visual", ed.mode, "visual");
	ed.handleInput(ESC);
	check("esc exits visual to normal", ed.mode, "normal");
	void modes;
}

// 41. v + motion + d deletes the inclusive selection.
{
	const { ed } = newEditor();
	type(ed, "hello world");
	ed.handleInput(ESC);
	ed.handleInput("0"); // on 'h'
	ed.handleInput("v"); // anchor at col 0
	ed.handleInput("l");
	ed.handleInput("l"); // cursor at col 2 ('l'); selection covers h,e,l
	ed.handleInput("d"); // delete "hel" inclusive
	check("visual d deletes inclusive span", ed.getText(), "lo world");
	check("visual d returns to normal", ed.mode, "normal");
}

// 42. visual c deletes the span and enters INSERT.
{
	const { ed } = newEditor();
	type(ed, "abcdef");
	ed.handleInput(ESC);
	ed.handleInput("0"); // on 'a'
	ed.handleInput("v");
	ed.handleInput("l");
	ed.handleInput("l"); // select a,b,c
	ed.handleInput("c"); // change
	check("visual c enters insert", ed.mode, "insert");
	type(ed, "X");
	check("visual c replaced span", ed.getText(), "Xdef");
}

// 43. V (visual-line) + d deletes the whole line.
{
	const { ed } = newEditor();
	type(ed, "one\ntwo\nthree");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("V"); // visual-line
	check("V enters visual-line", ed.mode, "visual-line");
	ed.handleInput("d"); // delete line 0
	check("visual-line d deletes line", ed.getText(), "two\nthree");
}

// 44. V + j extends over two lines, then d deletes both.
{
	const { ed } = newEditor();
	type(ed, "a\nb\nc\nd");
	ed.handleInput(ESC);
	ed.handleInput("g");
	ed.handleInput("g"); // line 0
	ed.handleInput("V");
	ed.handleInput("j"); // extend to line 1
	ed.handleInput("d"); // delete lines 0..1
	check("visual-line extends and deletes", ed.getText(), "c\nd");
}

// 45. A whole visual delete undoes as one unit.
{
	const { ed } = newEditor();
	type(ed, "hello world");
	ed.handleInput(ESC);
	ed.handleInput("0");
	ed.handleInput("v");
	ed.handleInput("e"); // select "hello"
	ed.handleInput("d"); // -> " world"
	check("visual d deleted word", ed.getText(), " world");
	ed.handleInput("u"); // one undo restores it
	check("u restores whole visual delete", ed.getText(), "hello world");
}

// 46. o swaps the selection ends so the other end moves.
{
	const { ed } = newEditor();
	type(ed, "abcdef");
	ed.handleInput(ESC);
	ed.handleInput("0"); // on 'a'
	ed.handleInput("l");
	ed.handleInput("l"); // on 'c' (col 2)
	ed.handleInput("v"); // anchor at col 2
	ed.handleInput("l"); // cursor col 3 ('d'); selection c,d
	ed.handleInput("o"); // swap: cursor now at col 2, anchor col 3
	check("o moved cursor to anchor start", ed.getCursor().col, 2);
	ed.handleInput("h"); // extend left; cursor col 1 ('b')
	ed.handleInput("d"); // selection now b,c,d -> delete
	check("o then extend deletes correct span", ed.getText(), "aef");
}

// --- EX (execute) mode --------------------------------------------------

// Wire the ex callbacks the way index.ts does, capturing host effects.
function newExEditor(commands: string[] = []): {
	ed: ModalVimEditor;
	ex: (string | null)[];
	dispatched: string[];
	notified: string[];
	quit: { count: number };
} {
	const ed = new ModalVimEditor(theme);
	const ex: (string | null)[] = [];
	const dispatched: string[] = [];
	const notified: string[] = [];
	const quit = { count: 0 };
	ed.onExCommandChange = (c) => ex.push(c);
	ed.runExCommand = (line) => {
		dispatched.push(line);
	};
	ed.notifyUser = (m) => notified.push(m);
	ed.onQuit = () => {
		quit.count++;
	};
	ed.getCommandNames = () => new Set(commands);
	return { ed, ex, dispatched, notified, quit };
}

const CR = "\r";
function typeEx(ed: ModalVimEditor, s: string): void {
	for (const ch of s) ed.handleInput(ch);
}

// 47. `:` opens ex; the mode stays NORMAL (ex is a sub-state).
{
	const { ed, ex } = newExEditor();
	ed.handleInput(ESC);
	ed.handleInput(":");
	check("`:` keeps VimMode normal", ed.mode, "normal");
	check("`:` opens ex buffer", ex.at(-1), ":");
	typeEx(ed, "q");
	check("typing extends ex buffer", ex.at(-1), ":q");
}

// 48. Esc cancels ex; Backspace on bare `:` exits.
{
	const { ed, ex } = newExEditor();
	ed.handleInput(ESC);
	ed.handleInput(":");
	ed.handleInput(ESC);
	check("esc clears ex", ex.at(-1), null);
	ed.handleInput(":");
	ed.handleInput("\x7f"); // backspace on bare ":"
	check("backspace on bare colon exits ex", ex.at(-1), null);
}

// 49. Backspace deletes the last ex char.
{
	const { ed, ex } = newExEditor();
	ed.handleInput(ESC);
	typeEx(ed, ":qa");
	ed.handleInput("\x7f");
	check("backspace drops last ex char", ex.at(-1), ":q");
}

// 50. `:q` on empty prompt quits; ex clears.
{
	const { ed, ex, quit } = newExEditor();
	ed.handleInput(ESC); // empty buffer
	typeEx(ed, ":q");
	ed.handleInput(CR);
	check("`:q` on empty prompt quits", quit.count, 1);
	check("submit clears ex", ex.at(-1), null);
}

// 51. `:q` on a non-empty prompt warns and does NOT quit.
{
	const { ed, notified, quit } = newExEditor();
	type(ed, "draft text");
	ed.handleInput(ESC);
	typeEx(ed, ":q");
	ed.handleInput(CR);
	check("`:q` with dirty prompt does not quit", quit.count, 0);
	check("`:q` with dirty prompt warns", notified.at(-1)?.includes("not empty"), true);
	check("dirty-prompt `:q` preserves draft", ed.getText(), "draft text");
}

// 52. `:q!` force-quits even with a dirty prompt.
{
	const { ed, quit } = newExEditor();
	type(ed, "draft");
	ed.handleInput(ESC);
	typeEx(ed, ":q!");
	ed.handleInput(CR);
	check("`:q!` force-quits dirty prompt", quit.count, 1);
}

// 53. A known command dispatches `/name` and restores the draft.
{
	const { ed, dispatched } = newExEditor(["tree"]);
	type(ed, "my prompt");
	ed.handleInput(ESC);
	typeEx(ed, ":tree");
	ed.handleInput(CR);
	check("known command dispatches slash form", dispatched, ["/tree"]);
	check("dispatch restores the draft", ed.getText(), "my prompt");
}

// 54. Command args pass through after the first whitespace run.
{
	const { ed, dispatched } = newExEditor(["model"]);
	ed.handleInput(ESC);
	typeEx(ed, ":model opus");
	ed.handleInput(CR);
	check("command args pass through", dispatched, ["/model opus"]);
}

// 55. `:!cmd` and `:!!cmd` dispatch the shell line verbatim; `:!` alone is unsupported.
{
	const { ed, dispatched, notified } = newExEditor();
	ed.handleInput(ESC);
	typeEx(ed, ":!ls");
	ed.handleInput(CR);
	check("`:!ls` dispatches shell line", dispatched.at(-1), "!ls");
	typeEx(ed, ":!!git status");
	ed.handleInput(CR);
	check("`:!!cmd` dispatches out-of-context shell line", dispatched.at(-1), "!!git status");
	typeEx(ed, ":!");
	ed.handleInput(CR);
	check("bare `:!` is unsupported", notified.at(-1)?.includes("Unsupported"), true);
}

// 56. Reserved names notify and never dispatch.
{
	const { ed, dispatched, notified } = newExEditor(["w"]); // even if a command named w exists
	ed.handleInput(ESC);
	typeEx(ed, ":w");
	ed.handleInput(CR);
	check("reserved `:w` is not dispatched", dispatched, []);
	check("reserved `:w` notifies", notified.at(-1)?.includes("Reserved"), true);
}

// 57. Prototype-chain names are NOT treated as quit/reserved (Object.hasOwn guard).
{
	const { ed, notified, quit } = newExEditor();
	ed.handleInput(ESC); // empty prompt: a false quit-match would shut down
	typeEx(ed, ":toString");
	ed.handleInput(CR);
	check("`:toString` does not quit", quit.count, 0);
	check("`:toString` is unsupported, not reserved/quit", notified.at(-1)?.includes("Unsupported"), true);
}

// 58. Unknown command notifies unsupported.
{
	const { ed, dispatched, notified } = newExEditor(["tree"]);
	ed.handleInput(ESC);
	typeEx(ed, ":frobnicate");
	ed.handleInput(CR);
	check("unknown command not dispatched", dispatched, []);
	check("unknown command notifies unsupported", notified.at(-1)?.includes("Unsupported"), true);
}

// 59. A pasted newline in ex never auto-submits (first-line-wait).
{
	const { ed, ex, dispatched } = newExEditor(["tree"]);
	ed.handleInput(ESC);
	ed.handleInput(":");
	ed.handleInput("\x1b[200~tree\nrest\x1b[201~"); // bracketed paste with embedded newline
	check("paste keeps only the first line", ex.at(-1), ":tree");
	check("pasted newline does not auto-submit", dispatched, []);
}

// 60. Ex editing does not touch the undo timeline.
{
	const { ed } = newExEditor(["tree"]);
	type(ed, "hello");
	ed.handleInput(ESC);
	ed.handleInput("x"); // delete 'o' -> "hell" (one undo unit)
	check("normal edit applied", ed.getText(), "hell");
	typeEx(ed, ":tree");
	ed.handleInput(CR); // dispatch + restore, no undo unit
	ed.handleInput("u"); // should undo the `x`, not an ex artifact
	check("undo after ex reverts the real edit", ed.getText(), "hello");
}

// 61. The mode widget shows the EX command line.
{
	const themeStub = { fg: (_c: string, s: string) => s } as unknown as Theme;
	const widget = new ModeWidget("normal", themeStub);
	widget.setExCommand(":q");
	check("widget shows EX command", (widget.render(20)[0] ?? "").includes("EX :q_"), true);
	widget.setExCommand(null);
	check("widget reverts to mode label", (widget.render(20)[0] ?? "").includes("NORMAL"), true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
