import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ModalVimEditor, type VimMode } from "./modal-editor.js";
import { ModeWidget } from "./mode-widget.js";

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

		// One stable widget instance; the factory always returns it so
		// re-asserting the widget on a mode change repaints without churning
		// component identity.
		let widget: ModeWidget | undefined;

		const applyMode = (mode: VimMode): void => {
			widget?.setMode(mode);
			// Re-assert the widget so the host rebuilds the below-editor lane and
			// requests a render; the factory hands back the same instance.
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => (widget ??= new ModeWidget(mode, theme)), {
				placement: "belowEditor",
			});
			// Best-effort cursor-shape hint; harmless on terminals that ignore it.
			try {
				process.stdout.write(CURSOR_SHAPE[mode]);
			} catch (error) {
				log.debug?.(`pi-vim: cursor-shape write failed: ${String(error)}`);
			}
		};

		try {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = new ModalVimEditor(tui, theme, keybindings);
				editor.onModeChange = applyMode;
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
