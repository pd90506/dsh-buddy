/**
 * Rendering and chunking: the two places where a reply can be lost.
 *
 * Telegram rejects a body over 4096 UTF-16 units *after* entity parsing rather
 * than truncating it, so the length assertions here are about the **visible**
 * text, not the markup: 3000 bold characters are 3000 units and must survive in
 * one message even though their HTML is longer than the limit. The other half of
 * the file is about not losing content: media is carved out of prose without
 * dropping a character, and every chunk carries a plain-text twin for the case
 * where the markup is refused.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	escapeHtml,
	escapeHtmlAttribute,
	planMarkdown,
	planPlain,
	plainToTelegramHtml,
	TELEGRAM_TEXT_LIMIT,
	type TextChunk,
	type TextPlan,
} from "../../src/telegram/telegram/render.ts";

/** Every text chunk of a plan, in send order. */
function chunksOf(plans: readonly TextPlan[]): TextChunk[] {
	return plans.flatMap((plan) => (plan.kind === "text" ? [...plan.chunks] : []));
}

/** The visible text of every chunk, joined, for "nothing was lost" assertions. */
function visibleAll(plans: readonly TextPlan[]): string {
	return chunksOf(plans)
		.map((chunk) => chunk.plain)
		.join("");
}

test("escapeHtml escapes exactly the three characters Telegram's HTML mode needs", () => {
	assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
	assert.equal(escapeHtml("plain"), "plain");
	assert.equal(escapeHtmlAttribute('say "hi" & bye'), "say &quot;hi&quot; &amp; bye");
});

test("plainToTelegramHtml escapes and never interprets markup (R31)", () => {
	assert.equal(plainToTelegramHtml("**not bold** <b>x</b>"), "**not bold** &lt;b&gt;x&lt;/b&gt;");
	assert.equal(plainToTelegramHtml("选一个 provider："), "选一个 provider：");
});

test("headings, emphasis and inline code map to the tags Telegram renders", () => {
	const [heading] = chunksOf(planMarkdown("## 标题"));
	assert.equal(heading?.html, "<b>标题</b>");
	const [paragraph] = chunksOf(planMarkdown("**b** *i* ~~s~~ ||p|| `c`"));
	assert.equal(paragraph?.html, "<b>b</b> <i>i</i> <s>s</s> <tg-spoiler>p</tg-spoiler> <code>c</code>");
});

test("a link becomes an anchor with its attribute escaped", () => {
	const [chunk] = chunksOf(planMarkdown("[a&b](https://x/y?a=1&b=2)"));
	assert.equal(chunk?.html, '<a href="https://x/y?a=1&amp;b=2">a&amp;b</a>');
});

test("agent text can never smuggle a tag into the message", () => {
	const [chunk] = chunksOf(planMarkdown("<script>alert(1)</script> & <b>bold</b>"));
	assert.equal(chunk?.html, "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;");
});

test("a fenced block names its language, and an unknown one is left plain", () => {
	const [js] = chunksOf(planMarkdown("```js\nconst a = 1 < 2;\n```"));
	assert.equal(js?.html, '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>');
	const [unknown] = chunksOf(planMarkdown("```not-a-language\nx\n```"));
	assert.equal(unknown?.html, "<pre>x</pre>");
});

test("lists render their own bullets, ordinals and task boxes", () => {
	const [bullets] = chunksOf(planMarkdown("- one\n- two"));
	assert.equal(bullets?.html, "• one\n• two");
	const [ordered] = chunksOf(planMarkdown("1. first\n2. second"));
	assert.equal(ordered?.html, "1. first\n2. second");
	const [tasks] = chunksOf(planMarkdown("- [ ] todo\n- [x] done"));
	assert.equal(tasks?.html, "☐ todo\n☑ done");
	const [nested] = chunksOf(planMarkdown("- top\n  - inner"));
	assert.equal(nested?.html, "• top\n\u00a0\u00a0◦ inner");
});

test("quotes wrap their lines and long ones are collapsed behind a tap", () => {
	const [short] = chunksOf(planMarkdown("> one\n> two"));
	assert.equal(short?.html, "<blockquote>one\ntwo</blockquote>");
	const long = Array.from({ length: 7 }, (_, index) => `> line ${String(index)}`).join("\n");
	const [chunk] = chunksOf(planMarkdown(long));
	assert.match(chunk?.html ?? "", /^<blockquote expandable>/);
});

test("a table renders as an aligned monospace block with plain cells", () => {
	const [chunk] = chunksOf(
		planMarkdown("| name | value |\n| --- | --- |\n| a | **1** |\n| longer | 2 |"),
	);
	const html = chunk?.html ?? "";
	assert.match(html, /^<pre>/);
	assert.match(html, /<\/pre>$/);
	// Alignment: every row's first column is padded to the widest cell.
	const rows = html.replace(/^<pre>|<\/pre>$/g, "").split("\n");
	assert.equal(rows[0], "name   │ value");
	assert.match(rows[1] ?? "", /^─+┼─+$/);
	assert.equal(rows[2], "a      │ 1");
	// `pre` cannot contain other entities, so the bold markers are gone and the
	// cell is its plain text.
	assert.ok(!html.includes("<b>"), html);
});

test("a thematic break becomes a visible divider line", () => {
	const [chunk] = chunksOf(planMarkdown("---"));
	assert.equal(chunk?.html, "──────");
});

test("chunk length is measured on visible text, not on markup", () => {
	const limit = 200;
	const bold = `**${"x".repeat(150)}** `.repeat(2);
	for (const chunk of chunksOf(planMarkdown(bold, { limit }))) {
		assert.ok(chunk.plain.length <= limit, `${String(chunk.plain.length)} > ${String(limit)}`);
	}
	// Lots of small entities: the markup is three times the limit while the visible
	// text fits, so this has to stay one message.
	const chunks = chunksOf(planMarkdown(Array.from({ length: 50 }, () => "**ab**").join(" "), { limit }));
	assert.equal(chunks.length, 1);
	assert.ok((chunks[0]?.html.length ?? 0) > limit, "the fixture must exceed the limit in markup");
});

test("a long plain reply is split without losing a character", () => {
	const limit = 180;
	const source = Array.from({ length: 40 }, (_, index) => `line number ${String(index)}`).join("\n");
	const chunks = chunksOf(planMarkdown(source, { limit }));
	assert.ok(chunks.length > 1, "expected a split");
	for (const chunk of chunks) {
		assert.ok(chunk.plain.length <= limit, `chunk of ${String(chunk.plain.length)} units`);
	}
	for (const marker of ["line number 0", "line number 20", "line number 39"]) {
		assert.ok(chunks.map((chunk) => chunk.plain).join("\n").includes(marker), `lost ${marker}`);
	}
});

test("a fenced block cut across chunks is closed and reopened with its language", () => {
	const limit = 160;
	const body = Array.from({ length: 30 }, (_, index) => `row ${String(index)}`).join("\n");
	const chunks = chunksOf(planMarkdown(`\`\`\`py\n${body}\n\`\`\``, { limit }));
	assert.ok(chunks.length > 1, "expected the fence to be split");
	for (const chunk of chunks) {
		assert.match(chunk.html, /^<pre><code class="language-py">/);
		assert.match(chunk.html, /<\/code><\/pre>$/);
		assert.ok(!chunk.plain.includes("```"), "the fence marker must not reach the user");
	}
});

test("a single over-long line is cut at character boundaries instead of being sent oversized", () => {
	const limit = 100;
	const source = "x".repeat(limit * 2 + 17);
	const chunks = chunksOf(planMarkdown(source, { limit }));
	for (const chunk of chunks) {
		assert.ok(chunk.plain.length <= limit, `chunk of ${String(chunk.plain.length)} units`);
	}
	assert.equal(chunks.map((chunk) => chunk.plain).join("").length, source.length);
});

test("emoji and CJK are counted in UTF-16 units, like Telegram counts them", () => {
	const limit = 130;
	const source = "😀".repeat(200);
	const chunks = chunksOf(planMarkdown(source, { limit }));
	for (const chunk of chunks) {
		// Each emoji is a surrogate pair: two UTF-16 units.
		assert.ok(chunk.plain.length <= limit, `chunk of ${String(chunk.plain.length)} units`);
	}
	assert.equal(chunks.map((chunk) => chunk.plain).join(""), source);
});

test("an image in a paragraph is carved out at its position, with the alt text as its caption", () => {
	const plans = planMarkdown("before ![chart](/tmp/w/chart.png) after");
	assert.deepEqual(
		plans.map((plan) => plan.kind),
		["text", "image", "text"],
	);
	assert.deepEqual(plans[1], { kind: "image", src: "/tmp/w/chart.png", alt: "chart" });
	assert.equal(visibleAll(plans), "before  after");
});

test("an image-only paragraph becomes a standalone image", () => {
	assert.deepEqual(planMarkdown("![a](p.png)"), [{ kind: "image", src: "p.png", alt: "a" }]);
});

test("an image on its own list line keeps the list readable around it", () => {
	const plans = planMarkdown("- step one\n- ![chart](c.png)\n- step two");
	assert.deepEqual(
		plans.map((plan) => plan.kind),
		["text", "image", "text"],
	);
	assert.equal(chunksOf(plans)[0]?.html, "• step one");
	assert.equal(chunksOf(plans)[1]?.html, "• step two");
});

test("an image inside a quote keeps the wrapper closed on both sides", () => {
	const plans = planMarkdown("> intro\n>\n> ![chart](c.png)\n>\n> outro");
	assert.deepEqual(
		plans.map((plan) => plan.kind),
		["text", "image", "text"],
	);
	const first = chunksOf(plans)[0];
	assert.match(first?.html ?? "", /^<blockquote>intro/);
	assert.match(first?.html ?? "", /<\/blockquote>$/);
});

test("every chunk carries a plain twin with the markup stripped", () => {
	const chunks = chunksOf(planMarkdown("**bold** and `code` and [link](https://x)", { limit: 20 }));
	const joined = chunks.map((chunk) => chunk.plain).join("");
	for (const chunk of chunks) {
		assert.ok(!chunk.plain.includes("**"), chunk.plain);
		assert.ok(!chunk.plain.includes("<b>"), chunk.plain);
	}
	// Nothing was dropped on the way: the visible text of the whole reply survives.
	for (const marker of ["bold", "code", "link"]) {
		assert.ok(joined.includes(marker), `lost ${marker}: ${joined}`);
	}
});

test("plain mode keeps today's behaviour: escape everything, keep fences and inline code", () => {
	const chunks = planPlain("**not bold**\n```js\nconst a = 1;\n```\nand `x < y`");
	assert.equal(
		chunks.map((chunk) => chunk.html).join("\n"),
		'**not bold**\n<pre><code class="language-js">const a = 1;</code></pre>\nand <code>x &lt; y</code>',
	);
});

test("plain mode splits to the same visible budget and never loses text", () => {
	const source = "y".repeat(TELEGRAM_TEXT_LIMIT * 2);
	const chunks = planPlain(source);
	assert.ok(chunks.length >= 2);
	for (const chunk of chunks) {
		assert.ok(chunk.plain.length <= TELEGRAM_TEXT_LIMIT - 16, String(chunk.plain.length));
	}
	assert.equal(chunks.map((chunk) => chunk.plain).join(""), source);
});
