import { describe, expect, test } from "bun:test";

import { ruleToggles, stringList } from "../src/config.ts";

describe("stringList", () => {
	test("returns the fallback for a non-array or empty-after-filter value", () => {
		expect(stringList(undefined, ["a"])).toEqual(["a"]);
		expect(stringList("click", ["a"])).toEqual(["a"]);
		expect(stringList([" ", 3, null], ["a"])).toEqual(["a"]);
	});

	test("trims, drops blanks, and de-duplicates", () => {
		expect(stringList([" click ", "pick", "pick", ""], ["a"])).toEqual(["click", "pick"]);
	});
});

describe("ruleToggles", () => {
	test("defaults every known rule to enabled", () => {
		expect(ruleToggles(undefined)).toEqual({ "browser-tools": true, difit: true, plannotator: true });
	});

	test("disables only the rules set to exactly false", () => {
		expect(ruleToggles({ difit: false, plannotator: 0 })).toEqual({ "browser-tools": true, difit: false, plannotator: true });
	});

	test("ignores unknown rule ids and non-object values", () => {
		expect(ruleToggles({ bogus: false })).toEqual({ "browser-tools": true, difit: true, plannotator: true });
		expect(ruleToggles(["difit"])).toEqual({ "browser-tools": true, difit: true, plannotator: true });
	});
});
