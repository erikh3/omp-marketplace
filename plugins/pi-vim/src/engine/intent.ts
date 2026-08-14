/**
 * EditIntent — the declarative vocabulary the vim engine returns.
 *
 * `evaluate(ctx, key)` returns an ordered `EditIntent[]`; the single effect
 * site `applyIntents(host, intents)` in `src/host/adapter.ts` executes them
 * in strict emission order.
 *
 * No new kind should be added without justification; see spec §5.5.
 */

import type { Pos, AbsRange, VimMode } from "../host/adapter.js";

export type EditIntent =
	| { kind: "moveCursor"; to: Pos }
	| { kind: "replaceRange"; range: AbsRange; text: string } // delete="", insert=empty range
	| { kind: "setMode"; mode: VimMode }
	| { kind: "setExBuffer"; value: string | null }
	| { kind: "runEx"; line: string }
	| { kind: "notify"; message: string }
	| { kind: "forward"; data: string };
