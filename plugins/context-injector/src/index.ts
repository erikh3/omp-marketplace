import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadMergedConfig } from "./config.ts";
import { buildSection } from "./inject.ts";
import type { ContextInjectorConfig } from "./types.ts";

export default function contextInjector(pi: ExtensionAPI): void {
	/**
	 * Tracks which entry indices (by position in the merged config) have already
	 * been injected this session. Reset on session_start so once-entries
	 * re-inject after a session switch or reload.
	 */
	const injectedIndices = new Set<number>();
	let config: ContextInjectorConfig = { inject: [] };

	pi.on("session_start", async (_event, ctx) => {
		injectedIndices.clear();
		try {
			config = loadMergedConfig(ctx.cwd);
			pi.logger.debug("context-injector: loaded config", {
				cwd: ctx.cwd,
				entryCount: config.inject.length,
				entries: config.inject.map((e) => e.path),
			});
		} catch (err) {
			pi.logger.warn("context-injector: failed to load config", { err });
			config = { inject: [] };
		}
	});

	pi.on("before_agent_start", async () => {
		if (config.inject.length === 0) return;

		pi.logger.debug("context-injector: before_agent_start fired", {
			totalEntries: config.inject.length,
			alreadyInjected: Array.from(injectedIndices),
		});

		const sections: string[] = [];
		let anyDisplay = false;

		for (let i = 0; i < config.inject.length; i++) {
			const entry = config.inject[i]!;
			const once = entry.once ?? true;

			if (once && injectedIndices.has(i)) {
				pi.logger.debug(`context-injector: skipping already-injected entry [${i}]`, {
					path: entry.path,
				});
				continue;
			}

			const section = await buildSection(entry, pi.logger);

			if (!section) continue;

			sections.push(section);
			if (entry.display) anyDisplay = true;
			if (once) injectedIndices.add(i);

			pi.logger.debug(`context-injector: injected entry [${i}]`, {
				path: entry.path,
				once,
				display: entry.display ?? false,
				chars: section.length,
			});
		}

		if (sections.length === 0) {
			pi.logger.debug("context-injector: nothing to inject this turn");
			return;
		}

		pi.logger.debug("context-injector: injecting context message", {
			sectionCount: sections.length,
			display: anyDisplay,
			totalChars: sections.reduce((n, s) => n + s.length, 0),
		});

		return {
			message: {
				customType: "context-injector",
				content: sections.join("\n\n---\n\n"),
				display: anyDisplay,
				attribution: "agent" as const,
			},
		};
	});
}
