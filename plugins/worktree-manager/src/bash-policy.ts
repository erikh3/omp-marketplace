import { isAbsolute, resolve } from "node:path";

interface ParsedGitWorktreeCommand {
	destination: string;
	repositoryHint: string;
}

function splitCommands(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === "\\" && quote !== "'") {
			current += character + (command[index + 1] ?? "");
			index += 1;
			continue;
		}
		if (character === "'" || character === "\"") {
			if (quote === character) quote = undefined;
			else if (!quote) quote = character;
			current += character;
			continue;
		}
		if (!quote && (character === ";" || character === "\n" || (character === "&" && command[index + 1] === "&") || (character === "|" && command[index + 1] === "|"))) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if (character !== ";" && character !== "\n") index += 1;
			continue;
		}
		current += character;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function tokenize(command: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === "\\" && quote !== "'") {
			const next = command[index + 1];
			if (next === undefined) return undefined;
			current += next;
			index += 1;
			continue;
		}
		if (character === "'" || character === "\"") {
			if (quote === character) quote = undefined;
			else if (!quote) quote = character;
			else current += character;
			continue;
		}
		if (!quote && /\s/.test(character)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (quote) return undefined;
	if (current) words.push(current);
	return words;
}

function optionNeedsValue(argument: string): boolean {
	return argument === "-C" || argument === "-c" || argument === "--git-dir" || argument === "--work-tree" || argument === "--namespace";
}

function worktreeOptionNeedsValue(argument: string): boolean {
	return argument === "-b" || argument === "-B" || argument === "--lock" || argument === "--reason";
}

function parseSegment(segment: string, cwd: string): ParsedGitWorktreeCommand | undefined {
	const words = tokenize(segment);
	if (!words) return undefined;
	let index = 0;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
	if (words[index] === "env") {
		index += 1;
		while ((words[index]?.startsWith("-") ?? false) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
	}
	if (words[index] === "command") index += 1;
	if (words[index] !== "git") return undefined;
	index += 1;

	let repositoryHint = cwd;
	while (index < words.length && words[index] !== "worktree") {
		const argument = words[index] ?? "";
		if (argument === "-C") {
			const path = words[index + 1];
			if (!path) return undefined;
			repositoryHint = resolve(repositoryHint, path);
			index += 2;
			continue;
		}
		if (argument.startsWith("-C") && argument.length > 2) {
			repositoryHint = resolve(repositoryHint, argument.slice(2));
			index += 1;
			continue;
		}
		if (!argument.startsWith("-")) return undefined;
		index += optionNeedsValue(argument) ? 2 : 1;
	}
	if (words[index] !== "worktree") return undefined;
	const operation = words[index + 1];
	if (operation !== "add" && operation !== "move") return undefined;
	index += 2;

	const positional: string[] = [];
	let options = true;
	while (index < words.length) {
		const argument = words[index] ?? "";
		if (options && argument === "--") {
			options = false;
			index += 1;
			continue;
		}
		if (options && argument.startsWith("-")) {
			index += worktreeOptionNeedsValue(argument) ? 2 : 1;
			continue;
		}
		positional.push(argument);
		index += 1;
	}
	const destination = operation === "add" ? positional[0] : positional[1];
	if (!destination || !isAbsolute(destination)) return undefined;
	return { destination, repositoryHint };
}

/** Finds absolute destinations from direct Git worktree add and move commands. */
export function parseDirectWorktreeCommands(command: string, cwd: string): ParsedGitWorktreeCommand[] {
	return splitCommands(command).flatMap((segment) => {
		const parsed = parseSegment(segment, cwd);
		return parsed ? [parsed] : [];
	});
}
