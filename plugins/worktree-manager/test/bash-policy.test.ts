import { expect, test } from "bun:test";
import { join } from "node:path";

import { parseDirectWorktreeCommands } from "../src/bash-policy.ts";

test("finds absolute worktree destinations through environment prefixes, command git, -C, and chains", () => {
	const repository = "/repos/example";
	const first = join(repository, "outside-first");
	const second = join(repository, "outside-second");

	const commands = parseDirectWorktreeCommands(
		`GIT_OPTIONAL_LOCKS=0 command git -C ${repository} --no-pager worktree add -b topic ${first} HEAD && git worktree move ${first} ${second}`,
		"/elsewhere",
	);

	expect(commands).toEqual([
		{ repositoryHint: repository, destination: first },
		{ repositoryHint: "/elsewhere", destination: second },
	]);
});
