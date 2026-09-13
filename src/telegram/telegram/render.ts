/**
 * Turning agent prose into what Telegram will accept, and into how many messages.
 *
 * Telegram applies a hard limit that shapes this whole module: a body may carry
 * **1–4096 UTF-16 code units after entity parsing**. The limit therefore applies
 * to the *visible* text, not to the markup we send, and it is counted in the same
 * unit JavaScript's `String#length` uses — so a 3000-character bold paragraph is
 * one message even though its HTML is longer, and an emoji costs two.
 *
 * Two more rules follow from the wire format:
 *
 * - **A chunk is independently valid.** Telegram re-parses the whole body of each
 *   message, so a wrapper that is open when a chunk ends must be closed and
 *   reopened around the next one — a code fence, a blockquote, a table. A chunk
 *   that ends inside `<pre>` renders as a stray backtick run otherwise.
 * - **Nothing may be lost.** Every chunk carries a `plain` twin: if Telegram
 *   refuses the markup (`can't parse entities`) the sender resends the escaped
 *   text instead of dropping the reply.
 *
 * Rendering happens at line granularity on purpose. Wrappers are per unit, lines
 * are the smallest thing that may cross a message boundary, and the only content
 * ever split mid-line is a single line longer than an entire message — cut at a
 * character boundary, as escaped text, where inline formatting is meaningless
 * anyway.
 * @module dsh-telegram/telegram/render
 */
import {
	parseMarkdown,
	type Block,
	type Inline,
	type InlineLine,
	type ListItem,
	type TableRow,
} from "./markdown.ts";

/** Telegram's per-message text ceiling, in UTF-16 code units. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Room reserved for the ` (nn/nn)` chunk indicator plus a re-closed wrapper. */
const INDICATOR_RESERVE = 16;

/** The divider a thematic break becomes; Telegram has no `hr` entity. */
const RULE_LINE = "──────";

/** Nesting indent, in non-breaking spaces, so clients keep it visible. */
const LIST_INDENT = "\u00a0\u00a0";

/**
 * Fence languages Telegram highlights.
 *
 * Telegram takes the language from a `class="language-…"` on a nested `code` tag
 * and ignores what it does not know, but a non-language would still ride every
 * message as an attribute. A whitelist keeps the attribute honest and the message
 * smaller; anything else renders as a plain `<pre>`.
 */
const SUPPORTED_LANGUAGES: readonly string[] = [
	"bash", "c", "clojure", "cpp", "cs", "css", "dart", "diff", "dockerfile", "elixir", "erlang",
	"go", "graphql", "groovy", "haskell", "html", "ini", "java", "javascript", "js", "json",
	"jsx", "kotlin", "lua", "makefile", "markdown", "md", "nix", "patch", "perl", "php", "pl",
	"plaintext", "powershell", "proto", "ps1", "py", "python", "r", "rb", "rs", "ruby", "rust",
	"scala", "scss", "sh", "shell", "sql", "swift", "toml", "ts", "tsx", "txt", "typescript",
	"vim", "xml", "yaml", "yml", "zsh",
];

/** A message body ready to send, with the escaped twin used if markup is refused. */
export interface TextChunk {
	/** Telegram HTML. */
	readonly html: string;
	/** The same content as escaped plain text, within the same visible budget. */
	readonly plain: string;
}

/**
 * The `(i/n)` suffix for one text message of a reply.
 *
 * Telegram's ceiling is what forces a split, so the reader is told which piece
 * they are reading. One message gets no suffix: "(1/1)" tells nobody anything.
 * @param index - 1-based position of this text message.
 * @param total - how many text messages the reply has.
 * @returns the suffix, or an empty string when there is nothing to number.
 */
export function ordinalSuffix(index: number, total: number): string {
	return total > 1 ? ` (${String(index)}/${String(total)})` : "";
}

/** One piece of a reply: text already split for sending, or an image to upload. */
export type TextPlan =
	| { readonly kind: "text"; readonly chunks: readonly TextChunk[] }
	| { readonly kind: "image"; readonly src: string; readonly alt: string };

/** Knobs of {@link planMarkdown}. */
export interface TextPlanOptions {
	/** Per-message ceiling, overridable for tests. */
	readonly limit?: number | undefined;
}

/** Escape the three characters Telegram's HTML parse mode cares about. */
export function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape a value destined for a quoted attribute (the fourth entity Telegram allows). */
export function escapeHtmlAttribute(text: string): string {
	return escapeHtml(text).replaceAll('"', "&quot;");
}

/**
 * Render plugin-authored text as Telegram HTML by escaping only.
 *
 * The plugin's own strings — help screens, menus, status lines — are not agent
 * prose and must never be run through the Markdown parser: a model id with an
 * underscore or an error message with an asterisk would come back reformatted.
 * @param text - the raw string to send.
 * @returns HTML that shows exactly those characters.
 */
export function plainToTelegramHtml(text: string): string {
	return escapeHtml(text);
}

/** One rendered source line: its markup and the text the reader actually sees. */
interface RenderedLine {
	readonly html: string;
	readonly plain: string;
}

/** The tags a block renders inside, re-emitted around every chunk of it. */
interface Wrap {
	readonly open: string;
	readonly close: string;
}

/** A wrapped group of lines; the wrapper is re-emitted around every chunk. */
interface RenderUnit extends Wrap {
	readonly lines: readonly RenderedLine[];
}

/** One image lifted out of prose, before its bytes are looked up. */
interface ImagePart {
	readonly src: string;
	readonly alt: string;
}

/** Internal form of {@link TextPlan}: text before chunking, or an image. */
type Segment = { readonly kind: "text"; readonly units: readonly RenderUnit[] } | ({ readonly kind: "image" } & ImagePart);

/** One run of a line: ordinary inline content, or an image to lift out of it. */
type InlineRun = { readonly kind: "text"; readonly nodes: readonly Inline[] } | ({ readonly kind: "image" } & ImagePart);

/** One item inside a block: a line to render, or an image to lift out of it. */
type RenderItem = { readonly kind: "line"; readonly line: RenderedLine } | ({ readonly kind: "image" } & ImagePart);

/** An unwrapped unit: a paragraph, a list, a divider. */
const PLAIN_WRAP: Wrap = { open: "", close: "" };

/** Mutable pair used while rendering inline nodes. */
interface Sink {
	html: string;
	plain: string;
}

/** Render inline nodes into markup and visible text at the same time. */
function renderInlines(nodes: readonly Inline[], sink: Sink): void {
	for (const node of nodes) {
		switch (node.type) {
			case "text":
				sink.html += escapeHtml(node.text);
				sink.plain += node.text;
				break;
			case "strong":
				sink.html += "<b>";
				renderInlines(node.children, sink);
				sink.html += "</b>";
				break;
			case "emphasis":
				sink.html += "<i>";
				renderInlines(node.children, sink);
				sink.html += "</i>";
				break;
			case "strike":
				sink.html += "<s>";
				renderInlines(node.children, sink);
				sink.html += "</s>";
				break;
			case "spoiler":
				sink.html += "<tg-spoiler>";
				renderInlines(node.children, sink);
				sink.html += "</tg-spoiler>";
				break;
			case "code":
				sink.html += `<code>${escapeHtml(node.text)}</code>`;
				sink.plain += node.text;
				break;
			case "link":
				sink.html += `<a href="${escapeHtmlAttribute(node.href)}">`;
				renderInlines(node.children, sink);
				sink.html += "</a>";
				break;
			case "image":
				// Images are lifted out of their block before rendering; this is the
				// fallback for one nested somewhere the extractor does not reach, and
				// showing the alt text beats showing a broken upload.
				sink.html += escapeHtml(node.alt === "" ? node.src : node.alt);
				sink.plain += node.alt === "" ? node.src : node.alt;
				break;
		}
	}
}

/** Render one source line. */
function renderLine(nodes: InlineLine): RenderedLine {
	const sink: Sink = { html: "", plain: "" };
	renderInlines(nodes, sink);
	return { html: sink.html, plain: sink.plain };
}

/**
 * Split a line into runs of text and the images between them.
 *
 * Images are not something a text message can contain — Telegram has no inline
 * image entity — so each one becomes a message of its own at the position it was
 * written, which is also where the reader expects the chart.
 * @param inlines - one parsed line.
 * @returns alternating text runs and images, in order.
 */
function splitImages(inlines: InlineLine): readonly InlineRun[] {
	const runs: InlineRun[] = [];
	let pending: Inline[] = [];
	for (const node of inlines) {
		if (node.type === "image") {
			if (pending.length > 0) runs.push({ kind: "text", nodes: pending });
			pending = [];
			runs.push({ kind: "image", src: node.src, alt: node.alt });
			continue;
		}
		pending.push(node);
	}
	if (pending.length > 0) runs.push({ kind: "text", nodes: pending });
	return runs;
}

/** Lift images out of a block's lines, leaving the text runs in order. */
function linesToItems(lines: readonly InlineLine[]): RenderItem[] {
	const items: RenderItem[] = [];
	for (const inlineLine of lines) {
		for (const run of splitImages(inlineLine)) {
			if (run.kind === "text") {
				items.push({ kind: "line", line: renderLine(run.nodes) });
				continue;
			}
			items.push({ kind: "image", src: run.src, alt: run.alt });
		}
	}
	return items;
}

/** Group consecutive line items into one wrapped unit per run. */
function groupItems(items: readonly RenderItem[], wrap: Wrap): Segment[] {
	const segments: Segment[] = [];
	let pending: RenderedLine[] = [];
	const flush = (): void => {
		if (pending.length === 0) return;
		segments.push({ kind: "text", units: [{ open: wrap.open, close: wrap.close, lines: pending }] });
		pending = [];
	};
	for (const item of items) {
		if (item.kind === "image") {
			flush();
			segments.push({ kind: "image", src: item.src, alt: item.alt });
			continue;
		}
		pending.push(item.line);
	}
	flush();
	return segments;
}

/** One list item's bullet, ordinal or checkbox. */
function bulletOf(item: ListItem): string {
	switch (item.marker) {
		case "ordered":
			return `${String(item.ordinal ?? 1)}.`;
		case "task-done":
			return "☑";
		case "task-todo":
			return "☐";
		default:
			return item.depth === 0 ? "•" : item.depth === 1 ? "◦" : "▪";
	}
}

/** A list's lines, each with its indent and bullet. */
function listItems(items: readonly ListItem[]): RenderItem[] {
	const out: RenderItem[] = [];
	for (const item of items) {
		const indent = LIST_INDENT.repeat(item.depth);
		const bullet = `${indent}${bulletOf(item)} `;
		const continuation = `${indent}${" ".repeat(bulletOf(item).length + 1)}`;
		item.lines.forEach((inlineLine, index) => {
			const runs = splitImages(inlineLine);
			runs.forEach((run, runIndex) => {
				if (run.kind === "image") {
					out.push({ kind: "image", src: run.src, alt: run.alt });
					return;
				}
				const rendered = renderLine(run.nodes);
				const prefix = index === 0 && runIndex === 0 ? bullet : continuation;
				out.push({ kind: "line", line: { html: prefix + rendered.html, plain: prefix + rendered.plain } });
			});
		});
	}
	return out;
}

/** Display columns of a string: wide glyphs take two, everything else one. */
function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += isWide(char) ? 2 : 1;
	return width;
}

/** Whether a code point occupies two terminal/phone columns. */
function isWide(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f9ff)
	);
}

/** Pad a cell to a column width with ordinary spaces. */
function padTo(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Render a table as an aligned monospace block.
 *
 * `pre` cannot contain other entities, so every cell is flattened to its plain
 * text first: a bold value inside a table shows as its characters, which is what
 * the alignment then depends on.
 */
function tableLine(header: TableRow, rows: readonly TableRow[]): RenderedLine {
	const plainRow = (row: TableRow): string[] => row.map((cell) => renderLine(cell).plain);
	const all = [plainRow(header), ...rows.map(plainRow)];
	const columns = all.reduce((width, row) => Math.max(width, row.length), 0);
	const widths = Array.from({ length: columns }, (_, column) =>
		all.reduce((width, row) => Math.max(width, displayWidth(row[column] ?? "")), 0),
	);
	// The last column is left unpadded: trailing spaces cost budget, show nothing,
	// and make a copy-paste of the table ragged.
	const join = (row: readonly string[]): string =>
		Array.from({ length: columns }, (_, column) =>
			column === columns - 1 ? (row[column] ?? "") : padTo(row[column] ?? "", widths[column] ?? 0),
		).join(" │ ");
	const separator = widths.map((width) => "─".repeat(Math.max(1, width))).join("─┼─");
	const body = [join(all[0] ?? []), separator, ...all.slice(1).map(join)].join("\n");
	return { html: escapeHtml(body), plain: body };
}

/** Code block lines: escaped verbatim, never parsed as markup. */
function codeItems(block: Extract<Block, { type: "code" }>): RenderUnit[] {
	if (block.lines.length === 0) return [];
	const language = block.language === undefined ? undefined : block.language.toLowerCase();
	const known = language !== undefined && SUPPORTED_LANGUAGES.includes(language);
	return [
		{
			open: known ? `<pre><code class="language-${escapeHtmlAttribute(language)}">` : "<pre>",
			close: known ? "</code></pre>" : "</pre>",
			lines: block.lines.map((line) => ({ html: escapeHtml(line), plain: line })),
		},
	];
}

/** Turn one block into segments. */
function segmentBlock(block: Block): Segment[] {
	switch (block.type) {
		case "heading":
			return groupItems(linesToItems([block.line]), { open: "<b>", close: "</b>" });
		case "paragraph":
			return groupItems(linesToItems(block.lines), PLAIN_WRAP);
		case "code": {
			const units = codeItems(block);
			return units.length === 0 ? [] : [{ kind: "text", units }];
		}
		case "quote":
			return groupItems(linesToItems(block.lines), {
				open: block.expandable ? "<blockquote expandable>" : "<blockquote>",
				close: "</blockquote>",
			});
		case "list":
			return groupItems(listItems(block.items), PLAIN_WRAP);
		case "rule":
			return groupItems([{ kind: "line", line: { html: RULE_LINE, plain: RULE_LINE } }], PLAIN_WRAP);
		case "table":
			return groupItems([{ kind: "line", line: tableLine(block.header, block.rows) }], { open: "<pre>", close: "</pre>" });
	}
}

/** Turn a parsed document into segments, in reading order. */
function segmentBlocks(blocks: readonly Block[]): Segment[] {
	const segments: Segment[] = [];
	for (const block of blocks) segments.push(...segmentBlock(block));
	return segments;
}

/**
 * Cut a single over-long line into message-sized pieces.
 *
 * A surrogate pair is never split: half a code point is not a character Telegram
 * can encode, and the repaired length is still within the budget.
 * @param text - the visible text of the line.
 * @param budget - maximum UTF-16 units per piece.
 * @returns the pieces, in order.
 */
function cutLine(text: string, budget: number): string[] {
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > budget) {
		let take = budget;
		const last = rest.charCodeAt(take - 1);
		if (last >= 0xd800 && last <= 0xdbff) take -= 1;
		pieces.push(rest.slice(0, Math.max(1, take)));
		rest = rest.slice(Math.max(1, take));
	}
	if (rest !== "") pieces.push(rest);
	return pieces;
}

/**
 * Pack segments into messages, keeping every wrapper valid per message.
 *
 * Lines flow into the current chunk until the budget is spent; a unit that
 * straddles a boundary is closed on one side and reopened on the other, and a
 * line too long for a whole message is cut as escaped text.
 * @param segments - the reply in reading order.
 * @param budget - visible UTF-16 units per message, indicator already reserved.
 * @returns the reply as text plans and images, in order.
 */
function packSegments(segments: readonly Segment[], budget: number): TextPlan[] {
	const plans: TextPlan[] = [];
	let chunks: TextChunk[] = [];
	let html = "";
	let plain = "";
	let close = "";
	let unit: RenderUnit | undefined;

	const closeChunk = (): void => {
		if (html === "" && plain === "") return;
		chunks.push({ html: html + close, plain });
		html = "";
		plain = "";
		close = "";
		unit = undefined;
	};
	const closePlace = (): void => {
		closeChunk();
		if (chunks.length > 0) {
			plans.push({ kind: "text", chunks });
			chunks = [];
		}
	};

	for (const segment of segments) {
		if (segment.kind === "image") {
			closePlace();
			plans.push(segment);
			continue;
		}
		for (const next of segment.units) {
			for (const line of next.lines) {
				// An empty line is a separator, not content: it only matters inside an
				// already open wrapper (a quote's blank line between paragraphs).
				if (line.html === "" && line.plain === "") {
					if (html !== "") {
						html += "\n";
						plain += "\n";
					}
					continue;
				}
				if (line.plain.length > budget) {
					closeChunk();
					for (const piece of cutLine(line.plain, budget)) {
						chunks.push({ html: next.open + escapeHtml(piece) + next.close, plain: piece });
					}
					continue;
				}
				const separator = plain === "" ? 0 : 1;
				if (plain.length + separator + line.plain.length > budget) closeChunk();
				if (html === "") {
					html = next.open + line.html;
					plain = line.plain;
					close = next.close;
					unit = next;
					continue;
				}
				if (unit === next) {
					html += `\n${line.html}`;
					plain += `\n${line.plain}`;
					continue;
				}
				// A different block in the same message: close the previous wrapper
				// before opening this one, or the tags interleave into invalid markup.
				html += `${close}\n${next.open}${line.html}`;
				plain += `\n${line.plain}`;
				close = next.close;
				unit = next;
			}
		}
	}
	closePlace();
	return plans;
}

/**
 * Plan one piece of agent text for sending.
 * @param text - the raw assistant text.
 * @param options - per-message ceiling, for tests.
 * @returns text chunks and standalone images, in reading order.
 */
export function planMarkdown(text: string, options: TextPlanOptions = {}): TextPlan[] {
	const budget = Math.max(1, (options.limit ?? TELEGRAM_TEXT_LIMIT) - INDICATOR_RESERVE);
	return packSegments(segmentBlocks(parseMarkdown(text)), budget);
}

/**
 * Plan text for sending with markup interpretation turned off.
 *
 * This is the escape hatch behind the settings switch: it escapes everything and
 * keeps only what the plugin rendered before this module grew a parser — fenced
 * code blocks and inline code spans. It deliberately does not reuse the Markdown
 * parser, because the mode exists for when that parser is the suspect.
 * @param text - the raw assistant text.
 * @param limit - per-message ceiling, overridable for tests.
 * @returns the message bodies to send, in order.
 */
export function planPlain(text: string, limit: number = TELEGRAM_TEXT_LIMIT): TextChunk[] {
	const budget = Math.max(1, limit - INDICATOR_RESERVE);
	const plans = packSegments(legacySegments(text), budget);
	return plans.flatMap((plan) => (plan.kind === "text" ? [...plan.chunks] : []));
}

/** Split plain text into runs of ordinary text and inline code spans. */
function legacyLine(line: string): RenderedLine {
	let html = "";
	let plain = "";
	for (const part of line.split(/(`[^`]*`)/)) {
		if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
			const inner = part.slice(1, -1);
			html += `<code>${escapeHtml(inner)}</code>`;
			plain += inner;
			continue;
		}
		html += escapeHtml(part);
		plain += part;
	}
	return { html, plain };
}

/** Fence opening for plain mode: character, length and optional language. */
function legacyFence(line: string): { readonly char: string; readonly length: number; readonly language: string | undefined } | undefined {
	const match = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
	const marker = match?.[1];
	if (marker === undefined) return undefined;
	const info = (match?.[2] ?? "").trim();
	return { char: marker[0] ?? "`", length: marker.length, language: info === "" ? undefined : info };
}

/** Whether a line closes the fence plain mode is inside. */
function legacyCloses(line: string, fence: { readonly char: string; readonly length: number }): boolean {
	const pattern = fence.char === "~" ? /^\s{0,3}(~{3,})\s*$/ : /^\s{0,3}(`{3,})\s*$/;
	const marker = pattern.exec(line)?.[1];
	return marker !== undefined && marker.length >= fence.length;
}

/** Today's behaviour, as segments: fences become `pre`, everything else is escaped. */
function legacySegments(text: string): Segment[] {
	const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const segments: Segment[] = [];
	let pending: RenderedLine[] = [];
	let index = 0;

	const flush = (): void => {
		if (pending.length === 0) return;
		segments.push({ kind: "text", units: [{ open: "", close: "", lines: pending }] });
		pending = [];
	};

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const fence = legacyFence(line);
		if (fence === undefined) {
			pending.push(legacyLine(line));
			index += 1;
			continue;
		}
		flush();
		const body: RenderedLine[] = [];
		index += 1;
		while (index < lines.length && !legacyCloses(lines[index] ?? "", fence)) {
			const code = lines[index] ?? "";
			body.push({ html: escapeHtml(code), plain: code });
			index += 1;
		}
		index += 1;
		if (body.length === 0) continue;
		const known = fence.language !== undefined && SUPPORTED_LANGUAGES.includes(fence.language.toLowerCase());
		segments.push({
			kind: "text",
			units: [
				{
					open: known ? `<pre><code class="language-${escapeHtmlAttribute(String(fence.language))}">` : "<pre>",
					close: known ? "</code></pre>" : "</pre>",
					lines: body,
				},
			],
		});
	}
	flush();
	return segments;
}
