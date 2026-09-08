/**
 * git-commit-linter extension entry point.
 *
 * Registers tool_call and tool_result middleware plus a session_shutdown
 * handler. On every model-issued Bash tool call the extension:
 *
 *  1. Parses the command for git commit invocations.
 *  2. Resolves each invocation to a repo root and cleaned message.
 *  3. Loads per-root config (once per unique root per call).
 *  4. If any root config is broken: skips all linting for this call,
 *     allows Bash to proceed, and stores a pending warning keyed by
 *     toolCallId to be prepended on the matching tool_result.
 *  5. Otherwise lints every message and blocks on the first error set.
 *
 * All failures collapse into a single reason string. Pending warnings are
 * stored in a bounded Map (max MAX_PENDING_WARNINGS entries; oldest evicted
 * on overflow). Each stored warning carries a managed-timer expiry so stale
 * entries that never receive a tool_result are eventually dropped.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { isToolCallEventType as isToolCallEventTypeFn } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { ConfigLoadResult } from "./types.ts";

import { resolve } from "node:path";

import { analyzeCommand } from "./commit-command.ts";
import { resolveCommit } from "./git-resolver.ts";
import { loadConfig } from "./config.ts";
import { lintCommit } from "./lint.ts";
import {
	formatBlockReason,
	formatLintErrors,
	formatBrokenConfigWarning,
} from "./format.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of pending warning entries retained at once.
 * When this limit is reached the oldest entry is evicted before inserting a
 * new one, keeping the Map bounded even if tool_result events never arrive.
 */
const MAX_PENDING_WARNINGS = 256;

/**
 * How long a pending warning is kept alive waiting for its tool_result, in
 * milliseconds. After this the entry is dropped and the warning is silently
 * lost — this is the fail-open path for a result that never arrives.
 */
const PENDING_WARNING_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Pending warning store
// ---------------------------------------------------------------------------

/** A pending broken-repo-config warning waiting for its tool_result. */
interface StoredWarning {
	/** Pre-formatted text to prepend to the matching tool_result content. */
	text: string;
	/** Managed-timer handle for auto-expiry. */
	timer: Timer;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function gitCommitLinterExtension(pi: ExtensionAPI): void {
	/** Bounded map of toolCallId → stored warning. */
	const pendingWarnings = new Map<string, StoredWarning>();

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/** Insert a pending warning, evicting the oldest entry when at capacity. */
	function storePendingWarning(
		toolCallId: string,
		text: string,
		ctx: ExtensionContext,
	): void {
		// Evict oldest entry when at capacity (Map preserves insertion order).
		while (pendingWarnings.size >= MAX_PENDING_WARNINGS) {
			const oldestKey = pendingWarnings.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = pendingWarnings.get(oldestKey);
			if (oldest !== undefined) ctx.clearTimer(oldest.timer);
			pendingWarnings.delete(oldestKey);
		}

		const timer = ctx.setTimeout(() => {
			pendingWarnings.delete(toolCallId);
		}, PENDING_WARNING_TTL_MS);

		pendingWarnings.set(toolCallId, { text, timer });
	}

	/** Consume and return a pending warning, cancelling its expiry timer. */
	function consumePendingWarning(
		toolCallId: string,
		ctx: ExtensionContext,
	): string | undefined {
		const entry = pendingWarnings.get(toolCallId);
		if (entry === undefined) return undefined;
		ctx.clearTimer(entry.timer);
		pendingWarnings.delete(toolCallId);
		return entry.text;
	}

	// -----------------------------------------------------------------------
	// tool_call handler
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
		// Only intercept model-issued Bash calls.
		if (!isToolCallEventTypeFn("bash", event)) return;

		const { toolCallId, input } = event;
		const rawCommand = input.command;

		// Resolve effective base cwd: event.input.cwd resolved against ctx.cwd.
		const baseCwd = input.cwd
			? resolve(ctx.cwd, input.cwd)
			: ctx.cwd;

		// Step 1: Parse the command.
		const analysis = analyzeCommand(rawCommand, baseCwd);

		if (analysis.kind === "no-commit") {
			// Nothing to lint.
			return;
		}

		if (analysis.kind === "blocked") {
			// Parser-level block (dangerous shell construct, expansion in git word, etc.)
			return {
				block: true,
				reason: formatBlockReason(analysis.reason, rawCommand),
			};
		}

		// analysis.kind === "commits"
		const { invocations } = analysis;

		// Step 2: Resolve every invocation.
		const resolvedList = await Promise.all(
			invocations.map((inv) => resolveCommit(inv)),
		);

		// Step 3: Collect unique repo roots from `lint` resolutions.
		const lintResolutions = resolvedList.filter((r) => r.resolution === "lint");

		// Check for resolver-level blocks.
		const blockedResolution = resolvedList.find((r) => r.resolution === "blocked");
		if (blockedResolution && blockedResolution.resolution === "blocked") {
			return {
				block: true,
				reason: formatBlockReason(blockedResolution.reason, rawCommand),
			};
		}

		if (lintResolutions.length === 0) {
			// All resolutions are skip/outside-repository — nothing to lint.
			return;
		}

		// Step 4: Load config per unique repo root.
		const rootsSet = new Set<string>(
			lintResolutions
				.filter((r): r is typeof r & { resolution: "lint" } => r.resolution === "lint")
				.map((r) => r.repoRoot),
		);

		const configResults = new Map<string, ConfigLoadResult>();
		await Promise.all(
			[...rootsSet].map(async (root) => {
				const result = await loadConfig(root);
				configResults.set(root, result);
			}),
		);

		// Step 4a: Any fatal config? Block immediately.
		for (const [, result] of configResults) {
			if (result.kind === "fatal") {
				const msg =
					result.error instanceof Error
						? result.error.message
						: String(result.error);
				return {
					block: true,
					reason: formatBlockReason(`Plugin config error: ${msg}`, rawCommand),
				};
			}
		}

		// Step 4b: Any broken-repository-config? Skip all linting, allow Bash,
		// store a combined warning.
		const brokenRoots = [...configResults.entries()].filter(
			([, result]) => result.kind === "broken-repository-config",
		);

		if (brokenRoots.length > 0) {
			// Build a combined warning across all broken roots.
			const warningParts = brokenRoots.map(([root, result]) => {
				const errMsg =
					result.kind === "broken-repository-config"
						? result.error instanceof Error
							? result.error.message
							: String(result.error)
						: "unknown error";
				return formatBrokenConfigWarning(errMsg, root);
			});
			const combinedWarning = warningParts.join("\n\n");

			storePendingWarning(toolCallId, combinedWarning, ctx);
			ctx.ui.notify(
				`git-commit-linter: linting skipped — broken repo config in ${brokenRoots.map(([r]) => r).join(", ")}`,
				"warning",
			);
			pi.logger.warn(
				"git-commit-linter: broken repo config, linting skipped for call",
				{ toolCallId, roots: brokenRoots.map(([r]) => r).join(", ") },
			);
			// Allow Bash to proceed.
			return;
		}

		// Step 5: Lint every `lint` resolution.
		for (const resolved of resolvedList) {
			if (resolved.resolution !== "lint") continue;

			const configResult = configResults.get(resolved.repoRoot);
			if (!configResult || configResult.kind !== "ready") continue;

			const lintResult = await lintCommit(
				resolved.message,
				resolved.invocation,
				resolved.repoRoot,
				configResult.config,
			);

			if (!lintResult.valid && lintResult.errors.length > 0) {
				const header = resolved.message.split(/\r\n|\r|\n/)[0] ?? "";
				return {
					block: true,
					reason: formatLintErrors(header, lintResult.errors),
				};
			}
		}

		// All checks passed — allow Bash.
	});

	// -----------------------------------------------------------------------
	// tool_result handler
	// -----------------------------------------------------------------------

	pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | void => {
		// Only process Bash results.
		if (event.toolName !== "bash") return;

		const warning = consumePendingWarning(event.toolCallId, ctx);
		if (warning === undefined) return;

		// Prepend the warning to the existing content with a blank line separator.
		const warningContent = { type: "text" as const, text: warning + "\n" };
		return {
			content: [warningContent, ...event.content],
		};
	});

	// -----------------------------------------------------------------------
	// session_shutdown handler
	// -----------------------------------------------------------------------

	pi.on("session_shutdown", (_event, ctx) => {
		// Cancel all outstanding expiry timers and drain the map.
		for (const [, entry] of pendingWarnings) {
			ctx.clearTimer(entry.timer);
		}
		pendingWarnings.clear();
	});
}
