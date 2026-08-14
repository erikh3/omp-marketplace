/**
 * OS-clipboard port for the register mirror.
 *
 * pi-vim's paste is synchronous (the register is read while computing edit
 * intents), but omp's clipboard read is async. So `peek()` serves a cached
 * value that `refresh()` updates in the background: the extension calls
 * `refresh()` on NORMAL entry and after mirror writes so the cache is warm
 * before a `p`. Every I/O path is defensive — a failure leaves the cache and
 * the editor untouched.
 */

import { copyToClipboard, readTextFromClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { ClipboardPort } from "../engine/registers.js";

/**
 * Build a {@link ClipboardPort} plus a `refresh()` the host calls to warm the
 * synchronous read cache. `write()` is fire-and-forget; `peek()` returns the
 * last successfully-read (or last-written) clipboard text, or null.
 */
export function makeClipboardPort(): { port: ClipboardPort; refresh: () => void } {
	let cache: string | null = null;

	const port: ClipboardPort = {
		write(text: string): void {
			// Optimistically prime the cache so an immediate put sees this write
			// before the async read lands.
			cache = text;
			void copyToClipboard(text).catch(() => {});
		},
		peek(): string | null {
			return cache;
		},
	};

	const refresh = (): void => {
		void readTextFromClipboard()
			.then((text) => {
				if (typeof text === "string") cache = text;
			})
			.catch(() => {});
	};

	return { port, refresh };
}
