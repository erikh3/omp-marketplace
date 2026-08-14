import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { ModalVimEditor, type VimMode } from "./modal-editor.js";
import { ModeWidget } from "./mode-widget.js";
import { loadPiVimConfig, DEFAULT_CONFIG, type PiVimConfig } from "./host/config.js";
import { makeClipboardPort } from "./host/clipboard.js";
import { makeModeChangeHandler } from "./host/mode-effects.js";
import { RegisterFile } from "./engine/registers.js";

/** DECSCUSR cursor shapes: steady block for NORMAL/VISUAL, blinking bar for INSERT. */
const CURSOR_SHAPE: Record<VimMode, string> = {
	normal: "\x1b[2 q",
	insert: "\x1b[5 q",
	visual: "\x1b[2 q",
	"visual-line": "\x1b[2 q",
};

const WIDGET_KEY = "pi-vim-mode";

/**
 * pi-vim for omp: modal editing in the prompt box.
 *
 * The prompt editor is swapped for a {@link ModalVimEditor} via
 * `ctx.ui.setEditorComponent`. INSERT mode is the stock editor; `Esc` drops to
 * NORMAL mode for motions/edits, and `i`/`a`/`o`/… return to INSERT. The active
 * mode is shown by a right-aligned widget below the editor (like Pi's TUI) and
 * by the terminal cursor shape.
 */
export default function piVim(pi: ExtensionAPI): void {
	const log = pi.logger;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Load pi-vim's own config (omp Settings can't hold a `piVim.*` namespace).
		// Fall back to defaults if the settings singleton isn't initialised.
		let config: PiVimConfig;
		try {
			config = loadPiVimConfig(settings.getAgentDir(), settings.getCwd());
		} catch (error) {
			config = DEFAULT_CONFIG;
			log.debug?.(`pi-vim: config load failed, using defaults: ${String(error)}`);
		}

		// OS-clipboard port; refreshed on NORMAL entry so a `p` reads a warm
		// cache. Always built (paste read-on-put and copyInputToClipboard need it);
		// the register's `clipboardMirror` policy decides whether writes mirror.
		const clip = makeClipboardPort();
		const onModeChangeEffects = makeModeChangeHandler(pi, config);

		// One stable widget instance; the factory always returns it so
		// re-asserting the widget on a mode change repaints without churning
		// component identity.
		let widget: ModeWidget | undefined;
		let currentMode: VimMode = "insert";

		const applyMode = (mode: VimMode): void => {
			const previousMode = currentMode;
			currentMode = mode;
			widget?.setMode(mode);
			// Re-assert the widget so the host rebuilds the below-editor lane and
			// requests a render; the factory hands back the same instance.
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => (widget ??= new ModeWidget(mode, theme, config.modeColors)),
				{ placement: "belowEditor" },
			);
			// Warm the clipboard read cache when entering NORMAL so a `p` sees an
			// up-to-date OS clipboard without a synchronous read.
			if (mode === "normal") clip.refresh();
			// Emit the mode-change event + run any configured shell hook, but not
			// for the initial INSERT assertion (no real transition).
			if (mode !== previousMode) onModeChangeEffects(mode, previousMode);
			// Best-effort cursor-shape hint; harmless on terminals that ignore it.
			try {
				process.stdout.write(CURSOR_SHAPE[mode]);
			} catch (error) {
				log.debug?.(`pi-vim: cursor-shape write failed: ${String(error)}`);
			}
		};

		const applyEx = (command: string | null): void => {
			widget?.setExCommand(command);
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => (widget ??= new ModeWidget(currentMode, theme, config.modeColors)),
				{ placement: "belowEditor" },
			);
			// Block cursor while ex is active; restore mode shape when cleared.
			try {
				process.stdout.write(command !== null ? "\x1b[2 q" : CURSOR_SHAPE[currentMode]);
			} catch (error) {
				log.debug?.(`pi-vim: cursor-shape write failed: ${String(error)}`);
			}
		};

		try {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = new ModalVimEditor(tui, theme, keybindings);
				editor.onModeChange = applyMode;
				editor.onExCommandChange = applyEx;
				// Leave `runExCommand` unset so the editor's ex dispatch falls through
				// to `setText(commandLine)` + `this.onSubmit(commandLine)` — the exact
				// path a manually typed `/tree`<Enter> or `!ls`<Enter> takes. The host
				// wires `onSubmit` onto this editor (InputController.setupEditorSubmitHandler),
				// and that handler is what interprets slash commands and `!` shell.
				// (An earlier build routed this through `pi.sendUserMessage`, which sends
				// the text to the LLM as a prompt instead of executing it — so `:tree`
				// reached the model as literal "/tree" and `!ls` as literal text.)
				editor.notifyUser = (message) => ctx.ui.notify(message, "warning");
				editor.getCommandNames = () => new Set([
					...BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
					...pi.getCommands().map((c) => c.name),
				]);
				// Inject the register file with the OS-clipboard port; the
				// `clipboardMirror` policy decides whether writes actually mirror.
				editor.setRegisterFile(new RegisterFile(clip.port, config.clipboardMirror));
				editor.exDispatchEnabled = config.exCommand.piDispatch;
				if (config.exCommand.copyInputToClipboard) {
					editor.copyPromptToClipboard = () => {
						const text = editor.getText();
						if (text.length > 0) clip.port.write(text);
					};
				}
				return editor;
			});
			// Fresh editor starts in INSERT; reflect that immediately.
			applyMode("insert");
			log.info("pi-vim: modal editor installed");
		} catch (error) {
			ctx.ui.notify(`pi-vim failed to install modal editor: ${String(error)}`, "error");
			log.error(`pi-vim setEditorComponent failed: ${String(error)}`);
		}
	});

	// Restore the default editor and clear the indicator on shutdown so a later
	// non-vim session (or a reload) is not left with our editor or widget.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		try {
			ctx.ui.setEditorComponent(undefined);
		} catch {
			// Editor may already be torn down during shutdown; ignore.
		}
	});
}
