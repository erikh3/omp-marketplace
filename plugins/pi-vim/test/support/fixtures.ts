/**
 * Shared sample buffers for editor tests, so unicode / multiline cases are
 * consistent and named. Import and embed in a cursor-marker `before` string, or
 * pass to `setText` directly.
 */

export const SINGLE = "the quick brown fox";
export const MULTILINE = "first line\nsecond line\nthird line";
/** Blank-line separated paragraphs for `{` / `}` motions. */
export const PARAGRAPHS = "a\nb\n\nc\nd\n\ne";
/** Nested pairs for `%` and `di(` / `da[` / … text objects. */
export const BRACKETS = "foo(bar[baz]qux)end";
/** Grapheme clusters: a ZWJ family sequence and a single-codepoint emoji. */
export const EMOJI = "a👨‍👩‍👧b🎉c";
/** CJK (wide) characters with spaces. */
export const CJK = "日本語 テスト です";
/** `é` written as base `e` + combining acute accent (U+0301). */
export const COMBINING = "e\u0301fg";
