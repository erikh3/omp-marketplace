/**
 * One-pass Bash command analyzer.
 *
 * Responsibilities:
 *   - Lex raw Bash input into tokens, preserving quote segments and expansion state.
 *   - Split token streams into simple commands via unquoted `&&`, `||`, `;`, newline, and `|`.
 *   - Expose simple-command token arrays to commit-command.ts for git commit recognition.
 *   - Block any input whose quoting, structure, or content cannot be statically resolved.
 *
 * Non-responsibilities (commit-command.ts owns these):
 *   - Git global option parsing.
 *   - Commit option parsing.
 *   - Message source determination.
 *   - cwd tracking.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One segment within a token. A segment is either plain text or a region
 * where shell expansion is active (inside `${}`, `$()`, double-quoted `$…`).
 */
export interface TokenSegment {
	/** The literal characters in this segment, after escape processing within its quote context. */
	readonly value: string;
	/** True when this segment contains or is derived from an active shell expansion. */
	readonly expansionActive: boolean;
}

/**
 * One parsed shell token, carrying its full reconstructed value, the
 * individual segments that compose it, and its position in the source string.
 */
export interface ShellToken {
	/** Logical token value (segments concatenated). */
	readonly value: string;
	/** Component segments with expansion-active tracking. */
	readonly segments: readonly TokenSegment[];
	/** Byte offset of the first character of this token in the raw input. */
	readonly start: number;
	/** Byte offset one past the last character of this token in the raw input. */
	readonly end: number;
	/**
	 * True when any segment is expansion-active (i.e. the token cannot be
	 * treated as a static literal).
	 */
	readonly hasExpansion: boolean;
}

/**
 * A simple command: a flat list of tokens representing one executable and its
 * arguments after splitting on unquoted separators.
 *
 * Redirections are noted (so the parser can check for stdin heredoc/here-string
 * inputs) but are stripped from the argument token list.
 */
export interface SimpleCommand {
	readonly tokens: readonly ShellToken[];
	/** True when the command has any input redirection (< <<, <<<, |). */
	readonly hasInputRedirection: boolean;
	/**
	 * True when the command's stdin is fed by a heredoc or here-string. These
	 * always block when a commit is detected.
	 */
	readonly hasHeredocInput: boolean;
}

/**
 * A fully split and validated command sequence.
 *
 * `blocked` means the raw input contained structure the parser cannot handle
 * safely (malformed quoting, subshell grouping around a potential commit, etc.).
 */
export type SplitResult =
	| { readonly kind: "commands"; readonly commands: readonly SimpleCommand[] }
	| { readonly kind: "blocked"; readonly reason: string; readonly code: BlockedCode };

/**
 * Stable reason codes for blocked parse results. Tests assert on these; never
 * change a code without a corresponding test update.
 */
export type BlockedCode =
	| "malformed-quoting"
	| "malformed-heredoc"
	| "heredoc-input"
	| "process-substitution"
	| "subshell-grouping"
	| "unsupported-grouping"
	| "expansion-in-structure"
	| "indirect-wrapper"
	| "dynamic-cd";

// ---------------------------------------------------------------------------
// Internal lexer state
// ---------------------------------------------------------------------------

type LexState =
	| "unquoted"
	| "single-quoted"
	| "double-quoted"
	| "escaped" // backslash outside any quote
	| "dq-escaped" // backslash inside double-quotes
	| "comment"
	| "heredoc-body";

interface HeredocDescriptor {
	/** The delimiter word (with quotes stripped, i.e. the literal string to match). */
	readonly delimiter: string;
	/** True when the delimiter was originally unquoted or double-quoted (expansion active). */
	readonly expansionActive: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a raw Bash command string into a sequence of simple commands.
 *
 * The parser is deliberately conservative: whenever it encounters syntax it
 * cannot resolve statically, it returns `blocked` with an explanatory code.
 *
 * @param raw  The raw Bash command string (may contain newlines).
 */
export function splitCommands(raw: string): SplitResult {
	return new CommandSplitter(raw).run();
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

/** Unquoted separator types that end a simple command or start a new one. */
type Separator = "&&" | "||" | ";" | "\n" | "|" | "|&" | "&";

class CommandSplitter {
	private readonly src: string;
	private pos = 0;

	// Current token accumulation
	private tokenStart = -1;
	private segments: TokenSegment[] = [];
	private segBuf = ""; // current plain segment buffer
	private segExpansion = false;

	// Token list for the current simple command
	private tokens: ShellToken[] = [];
	private hasInputRedir = false;
	private hasHeredocInput = false;

	// All finished simple commands
	private commands: SimpleCommand[] = [];

	// Heredoc queue: operators ahead of us that need body-scanning after
	// the current simple command line ends.
	private pendingHeredocs: HeredocDescriptor[] = [];

	private state: LexState = "unquoted";

	constructor(src: string) {
		this.src = src;
	}

	run(): SplitResult {
		try {
			return this.parse();
		} catch (e) {
			if (e instanceof BlockError) {
				return { kind: "blocked", reason: e.message, code: e.code };
			}
			throw e;
		}
	}

	private parse(): SplitResult {
		const src = this.src;
		const len = src.length;

		while (this.pos < len) {
			// ---------------------------------------------------------------
			// Heredoc body state — read until delimiter line
			// ---------------------------------------------------------------
			if (this.state === "heredoc-body") {
				this.scanHeredocBody();
				continue;
			}

			const ch = src[this.pos]!;

			// ---------------------------------------------------------------
			// Comment state
			// ---------------------------------------------------------------
			if (this.state === "comment") {
				if (ch === "\n") {
					this.state = "unquoted";
					this.pos++;
					this.handleSeparator("\n");
				} else {
					this.pos++;
				}
				continue;
			}

			// ---------------------------------------------------------------
			// Escaped (outside any quote)
			// ---------------------------------------------------------------
			if (this.state === "escaped") {
				if (ch === "\n") {
					// backslash-newline: line continuation, remove newline
					this.pos++;
				} else {
					this.appendLiteral(ch);
					this.pos++;
				}
				this.state = "unquoted";
				continue;
			}

			// ---------------------------------------------------------------
			// DQ-escaped (backslash inside double-quotes)
			// ---------------------------------------------------------------
			if (this.state === "dq-escaped") {
				// Inside double-quotes, backslash only escapes $, `, ", \, newline
				if (ch === "$" || ch === "`" || ch === '"' || ch === "\\" || ch === "\n") {
					if (ch === "\n") {
						// line continuation inside dq
					} else {
						this.appendLiteral(ch);
					}
				} else {
					// Non-special: keep the backslash and the char literally
					this.appendLiteral("\\");
					this.appendLiteral(ch);
				}
				this.pos++;
				this.state = "double-quoted";
				continue;
			}

			// ---------------------------------------------------------------
			// Single-quoted
			// ---------------------------------------------------------------
			if (this.state === "single-quoted") {
				if (ch === "'") {
					this.state = "unquoted";
					this.pos++;
				} else {
					// Every character inside single quotes is literal, including $ and #
					this.appendLiteral(ch);
					this.pos++;
				}
				continue;
			}

			// ---------------------------------------------------------------
			// Double-quoted
			// ---------------------------------------------------------------
			if (this.state === "double-quoted") {
				if (ch === '"') {
					this.state = "unquoted";
					this.pos++;
					continue;
				}
				if (ch === "\\") {
					this.pos++;
					this.state = "dq-escaped";
					continue;
				}
				if (ch === "$" || ch === "`") {
					// Expansion inside double quotes — mark as expansion-active
					const expResult = this.scanExpansion(true);
					if (expResult !== null) {
						this.flushSegment();
						this.segments.push({ value: expResult, expansionActive: true });
						this.segBuf = "";
						this.segExpansion = false;
					}
					continue;
				}
				// Ordinary character inside double-quotes
				this.appendLiteral(ch);
				this.pos++;
				continue;
			}

			// ---------------------------------------------------------------
			// Unquoted
			// ---------------------------------------------------------------

			// Backslash
			if (ch === "\\") {
				this.ensureTokenStarted();
				this.pos++;
				this.state = "escaped";
				continue;
			}

			// Single quote
			if (ch === "'") {
				this.ensureTokenStarted();
				this.pos++;
				this.state = "single-quoted";
				continue;
			}

			// Double quote
			if (ch === '"') {
				this.ensureTokenStarted();
				this.pos++;
				this.state = "double-quoted";
				continue;
			}

			// Comment start: only at a word boundary (token not yet started)
			if (ch === "#" && this.tokenStart === -1) {
				this.state = "comment";
				this.pos++;
				continue;
			}

			// Process substitution <(...) and >(...): block
			if ((ch === "<" || ch === ">") && this.pos + 1 < len && src[this.pos + 1] === "(") {
				throw new BlockError("process substitution is not statically resolvable", "process-substitution");
			}

			// Subshell/grouping: ( { — block when encountered as a command word
			if (ch === "(" || ch === "{") {
				// If we are inside a redirection context (just saw << or <<<), this is
				// handled elsewhere. Outside that, block.
				throw new BlockError(
					"subshell grouping or brace grouping is not statically resolvable",
					"subshell-grouping",
				);
			}
			if (ch === ")") {
				throw new BlockError(
					"unexpected closing parenthesis — unsupported grouping",
					"unsupported-grouping",
				);
			}
			if (ch === "}") {
				throw new BlockError(
					"unexpected closing brace — unsupported grouping",
					"unsupported-grouping",
				);
			}

			// Expansion: $ and `
			if (ch === "$" || ch === "`") {
				this.ensureTokenStarted();
				const expResult = this.scanExpansion(false);
				if (expResult !== null) {
					this.flushSegment();
					this.segments.push({ value: expResult, expansionActive: true });
					this.segBuf = "";
					this.segExpansion = false;
				}
				continue;
			}

			// Redirection operators: > >> < 2> 2>> 2>&1 <<< << <&
			// Try to recognize full redirection and consume it.
			if (this.isRedirectionStart(ch)) {
				const redir = this.scanRedirection();
				if (redir === null) {
					throw new BlockError("malformed redirection", "malformed-quoting");
				}
				this.finishCurrentToken(); // end any word token before the redir
				this.hasInputRedir = this.hasInputRedir || redir.isInput;
				this.hasHeredocInput = this.hasHeredocInput || redir.isHeredoc || redir.isHereString;
				if (redir.isHeredoc) {
					// Queue heredoc body scanning; consume after current line
					this.pendingHeredocs.push(redir.heredoc!);
				}
				continue;
			}

			// Pipe: | |&
			if (ch === "|") {
				if (this.pos + 1 < len && src[this.pos + 1] === "&") {
					this.finishCurrentToken();
					this.pos += 2;
					this.handleSeparator("|&");
				} else if (this.pos + 1 < len && src[this.pos + 1] === "|") {
					this.finishCurrentToken();
					this.pos += 2;
					this.handleSeparator("||");
				} else {
					this.finishCurrentToken();
					this.pos++;
					this.handleSeparator("|");
				}
				continue;
			}

			// Background: & (must not be &&)
			if (ch === "&") {
				if (this.pos + 1 < len && src[this.pos + 1] === "&") {
					this.finishCurrentToken();
					this.pos += 2;
					this.handleSeparator("&&");
				} else {
					// Background execution — treat as simple command terminator
					this.finishCurrentToken();
					this.pos++;
					this.handleSeparator("&");
				}
				continue;
			}

			// Semicolon
			if (ch === ";") {
				// ;; is a case-pattern terminator — treat like ; for now but it
				// signals a case statement which we cannot parse.
				if (this.pos + 1 < len && src[this.pos + 1] === ";") {
					throw new BlockError("case statement is not statically resolvable", "unsupported-grouping");
				}
				this.finishCurrentToken();
				this.pos++;
				this.handleSeparator(";");
				continue;
			}

			// Newline
			if (ch === "\n") {
				this.finishCurrentToken();
				this.pos++;
				this.handleSeparator("\n");
				continue;
			}

			// Whitespace (not newline) — token boundary
			if (ch === " " || ch === "\t" || ch === "\r") {
				this.finishCurrentToken();
				this.pos++;
				continue;
			}

			// Ordinary character
			this.ensureTokenStarted();
			this.appendLiteral(ch);
			this.pos++;
		}

		// End of input
		this.finishCurrentToken();
		this.finishCurrentCommand();

		// Validate quote state
		if (this.state === "single-quoted" || this.state === "double-quoted" || this.state === "dq-escaped") {
			throw new BlockError("unterminated quote", "malformed-quoting");
		}
		if (this.state === "escaped") {
			throw new BlockError("trailing backslash", "malformed-quoting");
		}
		if (this.pendingHeredocs.length > 0) {
			throw new BlockError("unterminated heredoc", "malformed-heredoc");
		}

		return { kind: "commands", commands: this.commands };
	}

	// ---------------------------------------------------------------------------
	// Heredoc body scanning
	// ---------------------------------------------------------------------------

	private scanHeredocBody(): void {
		if (this.pendingHeredocs.length === 0) {
			this.state = "unquoted";
			return;
		}
		const desc = this.pendingHeredocs.shift()!;
		const src = this.src;
		const len = src.length;

		// Read lines until we hit a line that is exactly the delimiter.
		// Heredoc bodies are consumed and discarded (they are flagged as blocking
		// at the point of recognition; this scan just advances pos).
		while (this.pos < len) {
			// Find the end of the current line
			let lineEnd = this.pos;
			while (lineEnd < len && src[lineEnd] !== "\n") lineEnd++;

			const line = src.slice(this.pos, lineEnd);
			this.pos = lineEnd < len ? lineEnd + 1 : lineEnd;

			if (line === desc.delimiter) {
				// Delimiter found — heredoc body consumed
				if (this.pendingHeredocs.length > 0) {
					// Another heredoc to scan in heredoc-body state
					return;
				}
				this.state = "unquoted";
				return;
			}
		}

		// Reached end of input without seeing delimiter
		throw new BlockError("unterminated heredoc", "malformed-heredoc");
	}

	// ---------------------------------------------------------------------------
	// Expansion scanning
	// ---------------------------------------------------------------------------

	/**
	 * Scan a `$...` or backtick expansion starting at `this.pos`.
	 * Returns the raw text of the expansion (for storage) and advances `this.pos`.
	 * Returns `null` only when a plain `$` is followed by end-of-input (edge case).
	 * Always marks the result as expansion-active.
	 */
	private scanExpansion(insideDq: boolean): string | null {
		const src = this.src;
		const len = src.length;
		const start = this.pos;
		const ch = src[this.pos]!;

		if (ch === "`") {
			// Backtick: scan to matching backtick (no nesting — conservative)
			this.pos++;
			const bstart = this.pos;
			while (this.pos < len && src[this.pos] !== "`") {
				if (src[this.pos] === "\\") this.pos++; // skip escaped char
				this.pos++;
			}
			if (this.pos >= len) {
				throw new BlockError("unterminated backtick command substitution", "malformed-quoting");
			}
			this.pos++; // consume closing `
			return src.slice(start, this.pos);
		}

		// ch === '$'
		this.pos++;
		if (this.pos >= len) return null;

		const next = src[this.pos]!;

		if (next === "(") {
			// $() — command substitution
			// If next+1 is '(' we have $((...)) — arithmetic
			this.pos++;
			let depth = 1;
			while (this.pos < len && depth > 0) {
				const c = src[this.pos]!;
				if (c === "(" ) depth++;
				else if (c === ")") depth--;
				else if (c === "\\") this.pos++; // skip escaped
				this.pos++;
			}
			if (depth !== 0) {
				throw new BlockError("unterminated command substitution $()", "malformed-quoting");
			}
			return src.slice(start, this.pos);
		}

		if (next === "{") {
			// ${...} — variable expansion
			this.pos++;
			let depth = 1;
			while (this.pos < len && depth > 0) {
				const c = src[this.pos]!;
				if (c === "{") depth++;
				else if (c === "}") depth--;
				else if (c === "'") {
					// $'...' ANSI-C quoting inside ${} — skip (conservative)
					this.pos++;
					while (this.pos < len && src[this.pos] !== "'") {
						if (src[this.pos] === "\\") this.pos++;
						this.pos++;
					}
				} else if (c === "\\") this.pos++;
				this.pos++;
			}
			if (depth !== 0) {
				throw new BlockError("unterminated variable expansion ${}", "malformed-quoting");
			}
			return src.slice(start, this.pos);
		}

		if (next === "'") {
			// $'...' ANSI-C quoting — not expansion but looks like $
			// This is actually a quoted string, not expansion. We treat it
			// as expansion-active (conservative) since we don't interpret escapes.
			this.pos++;
			while (this.pos < len && src[this.pos] !== "'") {
				if (src[this.pos] === "\\") this.pos++;
				this.pos++;
			}
			if (this.pos >= len) {
				throw new BlockError("unterminated $'...' quoting", "malformed-quoting");
			}
			this.pos++;
			return src.slice(start, this.pos);
		}

		if (next === '"') {
			// $"..." locale string — expansion-active
			this.pos++;
			while (this.pos < len && src[this.pos] !== '"') {
				if (src[this.pos] === "\\") this.pos++;
				this.pos++;
			}
			if (this.pos >= len) {
				throw new BlockError('unterminated $"..." quoting', "malformed-quoting");
			}
			this.pos++;
			return src.slice(start, this.pos);
		}

		// Plain $NAME, $@, $*, $#, $?, $!, $0-$9, $$
		// Scan the variable name
		if (isIdentStart(next) || isSpecialParam(next)) {
			this.pos++;
			if (isIdentStart(next)) {
				while (this.pos < len && isIdentContinue(src[this.pos]!)) this.pos++;
			}
			return src.slice(start, this.pos);
		}

		// Lone $ with nothing recognizable after it — treat as literal $ (no expansion)
		// This is technically a parse error in Bash, but be lenient for $var followed by odd chars.
		return src.slice(start, this.pos);
	}

	// ---------------------------------------------------------------------------
	// Redirection scanning
	// ---------------------------------------------------------------------------

	private isRedirectionStart(ch: string): boolean {
		if (ch === "<" || ch === ">") return true;
		// fd redirections like 2>, 2>>
		if (ch >= "0" && ch <= "9") {
			const next = this.pos + 1 < this.src.length ? this.src[this.pos + 1] : "";
			return next === ">" || next === "<";
		}
		return false;
	}

	private scanRedirection(): RedirResult | null {
		const src = this.src;
		const len = src.length;
		let i = this.pos;

		// Consume optional fd digit(s)
		while (i < len && src[i]! >= "0" && src[i]! <= "9") i++;

		if (i >= len) return null;
		const opCh = src[i]!;
		if (opCh !== "<" && opCh !== ">") return null;

		i++;
		if (i >= len) {
			// bare < or > at end — no target
			this.pos = i;
			return { isInput: opCh === "<", isHeredoc: false, isHereString: false };
		}

		const next = src[i]!;

		// Output: >> >>|
		if (opCh === ">") {
			if (next === ">") i++; // >>
			else if (next === "&") i++; // >&
			else if (next === "|") i++; // >|
			// skip whitespace after operator
			while (i < len && (src[i] === " " || src[i] === "\t")) i++;
			this.pos = i;
			// Consume the redirection target word
			this.consumeRedirTarget();
			return { isInput: false, isHeredoc: false, isHereString: false };
		}

		// Input: < << <<< <& <(
		if (next === "<") {
			i++; // second <
			if (i < len && src[i] === "<") {
				// here-string <<<
				i++;
				while (i < len && (src[i] === " " || src[i] === "\t")) i++;
				this.pos = i;
				this.consumeRedirTarget();
				return { isInput: true, isHeredoc: false, isHereString: true };
			}
			// heredoc <<
			while (i < len && (src[i] === " " || src[i] === "\t")) i++;
			this.pos = i;
			// Consume the heredoc delimiter word and record it
			const heredocDesc = this.consumeHeredocDelimiter();
			if (heredocDesc === null) {
				throw new BlockError("malformed heredoc delimiter", "malformed-heredoc");
			}
			return { isInput: true, isHeredoc: true, isHereString: false, heredoc: heredocDesc };
		}

		if (next === "&") {
			// <& — fd duplication (input)
			i++;
			while (i < len && (src[i] === " " || src[i] === "\t")) i++;
			this.pos = i;
			this.consumeRedirTarget();
			return { isInput: true, isHeredoc: false, isHereString: false };
		}

		// plain <
		while (i < len && (src[i] === " " || src[i] === "\t")) i++;
		this.pos = i;
		this.consumeRedirTarget();
		return { isInput: true, isHeredoc: false, isHereString: false };
	}

	/** Consume a redirection target word (stops at whitespace or separator). */
	private consumeRedirTarget(): void {
		const src = this.src;
		const len = src.length;
		// Process substitution <(...) or >(...) as a redirection target
		if (
			this.pos + 1 < len &&
			(src[this.pos] === "<" || src[this.pos] === ">") &&
			src[this.pos + 1] === "("
		) {
			throw new BlockError("process substitution is not statically resolvable", "process-substitution");
		}
		while (this.pos < len) {
			const ch = src[this.pos]!;
			if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "&" || ch === "|") break;
			if (ch === "'") {
				this.pos++;
				while (this.pos < len && src[this.pos] !== "'") this.pos++;
				if (this.pos < len) this.pos++;
			} else if (ch === '"') {
				this.pos++;
				while (this.pos < len && src[this.pos] !== '"') {
					if (src[this.pos] === "\\") this.pos++;
					this.pos++;
				}
				if (this.pos < len) this.pos++;
			} else if (ch === "\\") {
				this.pos += 2;
			} else {
				this.pos++;
			}
		}
	}

	/** Consume a heredoc delimiter and return its descriptor. */
	private consumeHeredocDelimiter(): HeredocDescriptor | null {
		const src = this.src;
		const len = src.length;
		let raw = "";
		let expansionActive = true;

		if (this.pos >= len) return null;

		const first = src[this.pos]!;
		if (first === "'" || first === '"') {
			// Quoted delimiter: expansion is suppressed (single) or active (double)
			expansionActive = first === '"';
			this.pos++;
			while (this.pos < len && src[this.pos] !== first) {
				raw += src[this.pos];
				this.pos++;
			}
			if (this.pos < len) this.pos++; // consume closing quote
		} else {
			// Unquoted — scan word
			while (this.pos < len) {
				const ch = src[this.pos]!;
				if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "&" || ch === "|") break;
				if (ch === "\\") {
					this.pos++;
					if (this.pos < len) {
						raw += src[this.pos];
						this.pos++;
					}
				} else {
					raw += ch;
					this.pos++;
				}
			}
		}

		if (!raw) return null;
		return { delimiter: raw, expansionActive };
	}

	// ---------------------------------------------------------------------------
	// Separator handling
	// ---------------------------------------------------------------------------

	private handleSeparator(_sep: Separator): void {
		this.finishCurrentCommand();
		// Scan any pending heredoc bodies before the next command
		if (this.pendingHeredocs.length > 0) {
			this.state = "heredoc-body";
		}
	}

	// ---------------------------------------------------------------------------
	// Token and command accumulation helpers
	// ---------------------------------------------------------------------------

	private ensureTokenStarted(): void {
		if (this.tokenStart === -1) {
			this.tokenStart = this.pos;
		}
	}

	private appendLiteral(ch: string): void {
		this.ensureTokenStarted();
		this.segBuf += ch;
	}

	private flushSegment(): void {
		if (this.segBuf.length > 0) {
			this.segments.push({ value: this.segBuf, expansionActive: this.segExpansion });
			this.segBuf = "";
			this.segExpansion = false;
		}
	}

	private finishCurrentToken(): void {
		if (this.tokenStart === -1) return; // no token in progress

		this.flushSegment();

		const value = this.segments.map((s) => s.value).join("");
		const hasExpansion = this.segments.some((s) => s.expansionActive);

		this.tokens.push({
			value,
			segments: [...this.segments],
			start: this.tokenStart,
			end: this.pos,
			hasExpansion,
		});

		// Reset accumulation state
		this.segments = [];
		this.segBuf = "";
		this.segExpansion = false;
		this.tokenStart = -1;
	}

	private finishCurrentCommand(): void {
		// If there is a token in progress, flush it first
		this.finishCurrentToken();

		if (this.tokens.length === 0) return; // empty command (e.g. trailing `;`)

		this.commands.push({
			tokens: [...this.tokens],
			hasInputRedirection: this.hasInputRedir,
			hasHeredocInput: this.hasHeredocInput,
		});

		this.tokens = [];
		this.hasInputRedir = false;
		this.hasHeredocInput = false;
	}
}

// ---------------------------------------------------------------------------
// Redirection result (internal)
// ---------------------------------------------------------------------------

interface RedirResult {
	readonly isInput: boolean;
	readonly isHeredoc: boolean;
	readonly isHereString: boolean;
	readonly heredoc?: HeredocDescriptor;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class BlockError extends Error {
	constructor(
		message: string,
		readonly code: BlockedCode,
	) {
		super(message);
		this.name = "BlockError";
	}
}

// ---------------------------------------------------------------------------
// Character class helpers
// ---------------------------------------------------------------------------

function isIdentStart(ch: string): boolean {
	return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentContinue(ch: string): boolean {
	return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function isSpecialParam(ch: string): boolean {
	// @, *, #, ?, !, -, $, 0-9
	return "@*#?!-$".includes(ch) || (ch >= "0" && ch <= "9");
}
