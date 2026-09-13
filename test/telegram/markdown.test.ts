/**
 * The simplified-Markdown parser: what the agent's prose means.
 *
 * Every case here is one row of the plan's mapping table plus the negative cases
 * that matter more than the positive ones — Chinese prose is full of `_`, `*` and
 * `|` that must survive untouched, because a wrong guess turns ordinary text into
 * markup and the phone shows something the agent never wrote.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, type Inline, type InlineLine } from "../../src/telegram/telegram/markdown.ts";

/** Shorthand for a plain text node. */
function t(value: string): Inline {
	return { type: "text", text: value };
}

test("an ATX heading keeps its level and drops the hashes", () => {
	assert.deepEqual(parseMarkdown("# Title"), [{ type: "heading", level: 1, line: [t("Title")] }]);
	assert.deepEqual(parseMarkdown("### Three ###"), [{ type: "heading", level: 3, line: [t("Three")] }]);
});

test("a hash without a space is ordinary text, not a heading", () => {
	assert.deepEqual(parseMarkdown("#NoSpace"), [{ type: "paragraph", lines: [[t("#NoSpace")]] }]);
	assert.deepEqual(parseMarkdown("####### seven"), [{ type: "paragraph", lines: [[t("####### seven")]] }]);
});

test("paragraph lines stay separate and a blank line ends the block", () => {
	const blocks = parseMarkdown("line one\nline two\n\nsecond paragraph");
	assert.deepEqual(blocks, [
		{ type: "paragraph", lines: [[t("line one")], [t("line two")]] },
		{ type: "paragraph", lines: [[t("second paragraph")]] },
	]);
});

test("a fenced block becomes code with its language, and an unterminated fence runs to the end", () => {
	assert.deepEqual(parseMarkdown("```js\nconst a = 1;\n```"), [
		{ type: "code", language: "js", lines: ["const a = 1;"] },
	]);
	assert.deepEqual(parseMarkdown("~~~python\nprint(1)\n~~~"), [
		{ type: "code", language: "python", lines: ["print(1)"] },
	]);
	assert.deepEqual(parseMarkdown("```\nstill typing"), [{ type: "code", language: undefined, lines: ["still typing"] }]);
	// The info string's first word is the language; the rest is decoration.
	assert.deepEqual(parseMarkdown("```ts title=x\ny\n```"), [{ type: "code", language: "ts", lines: ["y"] }]);
});

test("inline code keeps its bytes verbatim and never parses markup inside", () => {
	assert.deepEqual(parseMarkdown("a `x < y` b"), [
		{ type: "paragraph", lines: [[t("a "), { type: "code", text: "x < y" }, t(" b")]] },
	]);
	assert.deepEqual(parseMarkdown("``a ` b``"), [{ type: "paragraph", lines: [[{ type: "code", text: "a ` b" }]] }]);
	assert.deepEqual(parseMarkdown("an unmatched ` tick"), [{ type: "paragraph", lines: [[t("an unmatched ` tick")]] }]);
});

test("bold, italic, strike and spoiler nest inside one another", () => {
	assert.deepEqual(parseMarkdown("**bold**"), [
		{ type: "paragraph", lines: [[{ type: "strong", children: [t("bold")] }]] },
	]);
	assert.deepEqual(parseMarkdown("__bold__ *it* ~~gone~~ ||hidden||"), [
		{
			type: "paragraph",
			lines: [
				[
					{ type: "strong", children: [t("bold")] },
					t(" "),
					{ type: "emphasis", children: [t("it")] },
					t(" "),
					{ type: "strike", children: [t("gone")] },
					t(" "),
					{ type: "spoiler", children: [t("hidden")] },
				],
			],
		},
	]);
	assert.deepEqual(parseMarkdown("**bold *and italic* bold**"), [
		{
			type: "paragraph",
			lines: [
				[
					{
						type: "strong",
						children: [t("bold "), { type: "emphasis", children: [t("and italic")] }, t(" bold")],
					},
				],
			],
		},
	]);
});

test("underscores inside words are never emphasis (the snake_case rule)", () => {
	for (const source of ["snake_case_name", "file_name.txt", "a_b_c_d", "__init__.py", "http://a/b_c_d"]) {
		const blocks = parseMarkdown(source);
		assert.deepEqual(blocks, [{ type: "paragraph", lines: [[t(source)]] }], source);
	}
});

test("asterisks used as arithmetic or bullets stay literal", () => {
	for (const source of ["2 * 3 * 4", "a * b * c", "5*4", "** not bold **"]) {
		assert.deepEqual(parseMarkdown(source), [{ type: "paragraph", lines: [[t(source)]] }], source);
	}
});

test("unmatched delimiters are text, not half-open markup", () => {
	for (const source of ["**unclosed", "~~gone", "||spoil", "a ** b ** c"]) {
		assert.deepEqual(parseMarkdown(source), [{ type: "paragraph", lines: [[t(source)]] }], source);
	}
});

test("backslash escapes let the agent write a literal delimiter", () => {
	assert.deepEqual(parseMarkdown("\\*not italic\\*"), [{ type: "paragraph", lines: [[t("*not italic*")]] }]);
	assert.deepEqual(parseMarkdown("a \\`tick\\` b"), [{ type: "paragraph", lines: [[t("a `tick` b")]] }]);
});

test("only web-safe link schemes become links", () => {
	assert.deepEqual(parseMarkdown("[docs](https://example.com/x)"), [
		{
			type: "paragraph",
			lines: [[{ type: "link", href: "https://example.com/x", children: [t("docs")] }]],
		},
	]);
	assert.deepEqual(parseMarkdown("[me](mailto:a@b.c)"), [
		{ type: "paragraph", lines: [[{ type: "link", href: "mailto:a@b.c", children: [t("me")] }]] },
	]);
	// A script URL must never become a tappable link.
	assert.deepEqual(parseMarkdown("[x](javascript:alert(1))"), [
		{ type: "paragraph", lines: [[t("[x](javascript:alert(1))")]] },
	]);
	assert.deepEqual(parseMarkdown("![a](data:text/html;base64,PHNjcmlwdD4=)"), [
		{ type: "paragraph", lines: [[t("![a](data:text/html;base64,PHNjcmlwdD4=)")]] },
	]);
});

test("angle brackets around a URL are an autolink", () => {
	assert.deepEqual(parseMarkdown("<https://example.com>"), [
		{ type: "paragraph", lines: [[{ type: "link", href: "https://example.com", children: [t("https://example.com")] }]] },
	]);
	assert.deepEqual(parseMarkdown("<b>not html</b>"), [{ type: "paragraph", lines: [[t("<b>not html</b>")]] }]);
});

test("images become image nodes carrying their source and alt text", () => {
	assert.deepEqual(parseMarkdown("![chart](/tmp/w/chart.png)"), [
		{ type: "paragraph", lines: [[{ type: "image", src: "/tmp/w/chart.png", alt: "chart" }]] },
	]);
	assert.deepEqual(parseMarkdown("![](https://x/y.png)"), [
		{ type: "paragraph", lines: [[{ type: "image", src: "https://x/y.png", alt: "" }]] },
	]);
});

test("lists keep their markers, nesting and task state", () => {
	assert.deepEqual(parseMarkdown("- one\n- two"), [
		{
			type: "list",
			items: [
				{ marker: "bullet", ordinal: undefined, depth: 0, lines: [[t("one")]] },
				{ marker: "bullet", ordinal: undefined, depth: 0, lines: [[t("two")]] },
			],
		},
	]);
	assert.deepEqual(parseMarkdown("1. first\n2. second"), [
		{
			type: "list",
			items: [
				{ marker: "ordered", ordinal: 1, depth: 0, lines: [[t("first")]] },
				{ marker: "ordered", ordinal: 2, depth: 0, lines: [[t("second")]] },
			],
		},
	]);
	assert.deepEqual(parseMarkdown("- [ ] todo\n- [x] done"), [
		{
			type: "list",
			items: [
				{ marker: "task-todo", ordinal: undefined, depth: 0, lines: [[t("todo")]] },
				{ marker: "task-done", ordinal: undefined, depth: 0, lines: [[t("done")]] },
			],
		},
	]);
	// Two spaces of indent is one nesting level, capped so a pathological paste
	// cannot produce unbounded left margin on a phone.
	const nested = parseMarkdown("- top\n  - inner\n        - deep");
	const list = nested[0];
	assert.equal(list?.type, "list");
	if (list?.type !== "list") return;
	assert.deepEqual(list.items.map((item) => item.depth), [0, 1, 3]);
});

test("a grounded line continues the list item instead of becoming a paragraph", () => {
	const blocks = parseMarkdown("- first line\n  continued");
	const list = blocks[0];
	assert.equal(list?.type, "list");
	if (list?.type !== "list") return;
	assert.deepEqual(list.items[0]?.lines, [[t("first line")], [t("continued")]]);
});

test("a blockquote collects its lines and expands only when it is long", () => {
	assert.deepEqual(parseMarkdown("> quoted\n> more"), [
		{ type: "quote", expandable: false, lines: [[t("quoted")], [t("more")]] },
	]);
	const long = parseMarkdown(Array.from({ length: 7 }, (_, index) => `> line ${String(index)}`).join("\n"));
	assert.equal(long[0]?.type, "quote");
	assert.equal(long[0]?.type === "quote" && long[0].expandable, true);
});

test("thematic breaks are rules, and dashes inside a paragraph are not", () => {
	assert.deepEqual(parseMarkdown("---"), [{ type: "rule" }]);
	assert.deepEqual(parseMarkdown("***"), [{ type: "rule" }]);
	assert.deepEqual(parseMarkdown("___"), [{ type: "rule" }]);
	assert.deepEqual(parseMarkdown("- - -"), [{ type: "rule" }]);
	assert.deepEqual(parseMarkdown("a --- b"), [{ type: "paragraph", lines: [[t("a --- b")]] }]);
});

test("a pipe table needs its delimiter row, and then becomes a table", () => {
	assert.deepEqual(parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |"), [
		{ type: "table", header: [[t("a")], [t("b")]], rows: [[[t("1")], [t("2")]]] },
	]);
	// A lone pipe line is ordinary text — logs and code are full of those.
	assert.deepEqual(parseMarkdown("a | b"), [{ type: "paragraph", lines: [[t("a | b")]] }]);
	// Ragged rows are padded so the rendered table keeps its columns.
	const ragged = parseMarkdown("| a | b |\n| - | - |\n| 1 |");
	assert.equal(ragged[0]?.type, "table");
	assert.equal(ragged[0]?.type === "table" && ragged[0].rows[0]?.length, 2);
});

test("CRLF input, trailing spaces and empty input are handled", () => {
	assert.deepEqual(parseMarkdown("a\r\nb"), [{ type: "paragraph", lines: [[t("a")], [t("b")]] }]);
	assert.deepEqual(parseMarkdown(""), []);
	assert.deepEqual(parseMarkdown("\n\n"), []);
	// Trailing spaces are the agent's, not ours to trim.
	assert.deepEqual(parseMarkdown("a  \nb"), [{ type: "paragraph", lines: [[t("a  ")], [t("b")]] }]);
});

test("formatting inside a list item and a quote is parsed too", () => {
	const blocks = parseMarkdown("- **bold** item\n> *quoted*");
	const list = blocks[0];
	assert.equal(list?.type, "list");
	if (list?.type === "list") {
		assert.deepEqual(list.items[0]?.lines, [[{ type: "strong", children: [t("bold")] }, t(" item")]]);
	}
	const quote = blocks[1];
	assert.equal(quote?.type, "quote");
	if (quote?.type === "quote") {
		assert.deepEqual(quote.lines, [[{ type: "emphasis", children: [t("quoted")] }]]);
	}
});
