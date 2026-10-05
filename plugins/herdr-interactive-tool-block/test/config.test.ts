import { describe, expect, test } from "bun:test";

import { ruleToggles, stringList } from "../src/config.ts";

describe("stringList", () => {
	test("returns undefined for a non-array or empty-after-filter value", () => {
		expect(stringList(undefined)).toBeUndefined();
		expect(stringList("click")).toBeUndefined();
		expect(stringList([" ", 3, null])).toBeUndefined();
	});

	test("trims, drops blanks, and de-duplicates", () => {
		expect(stringList([" click ", "pick", "pick", ""])).toEqual(["click", "pick"]);
	});
});

describe("ruleToggles", () => {
	test("returns an empty override map for a non-object value", () => {
		expect(ruleToggles(undefined)).toEqual({});
		expect(ruleToggles(["difit"])).toEqual({});
	});

	test("keeps only boolean entries, so a rule disabled by false is recorded", () => {
		expect(ruleToggles({ difit: false, "browser-tools": true, plannotator: 0 })).toEqual({ difit: false, "browser-tools": true });
	});
});
