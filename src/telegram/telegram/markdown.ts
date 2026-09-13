/**
 * A simplified CommonMark subset, parsed into a typed AST.
 *
 * Telegram has no heading, table or list entity: the only way prose reads as
 * prose on a phone is to translate the few constructs an agent actually emits
 * into the entities Telegram does have (`b`, `i`, `s`, `tg-spoiler`, `a`,
 * `code`, `pre`, `blockquote`). This module owns the *meaning*; `render.ts` owns
 * the markup, and the split is what makes the tricky half testable without a
 * string-matching contest.
 *
 * The subset is deliberately narrow, and the direction of every unknown is the
 * same: **anything not recognized is literal text**. Agent prose is full of `_`,
 * `*` and `|` that are not markup — `snake_case`, `2 * 3`, `a | b`, a diff, a
 * log line — and turning one of those into formatting shows the user something
 * the agent never wrote. Missing a formatting cue is a cosmetic loss; inventing
 * one is a correctness bug, so the underscore rules below are deliberately
 * stricter than CommonMark's.
 *
 * Recognized: ATX headings, paragraphs, fenced code, inline code, `**`/`__`
 * bold, `*`/`_` italic, `~~` strike, `||` spoiler, `[text](url)` links with a
 * scheme allow-list, `<url>` autolinks, `![alt](src)` images, `-`/`*`/`+` and
 * ordered lists (nested, task markers), `>` quotes (long ones marked
 * expandable), thematic breaks, and GFM pipe tables. Not recognized (kept
 * literal): setext headings, reference links, footnotes, inline HTML, nested
 * quotes, indented code blocks.
 * @module dsh-telegram/telegram/markdown
 */

/** Nesting limit for inline markup; deeper input stays literal. */
const MAX_INLINE_DEPTH = 6;

/** A quote longer than this many lines renders collapsed behind a tap. */
export const EXPANDABLE_QUOTE_LINES = 5;

/** Maximum list nesting the renderer indents; deeper items flatten. */
export const MAX_LIST_DEPTH = 3;

/** One inline piece of a line. */
export type Inline =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "strong"; readonly children: readonly Inline[] }
	| { readonly type: "emphasis"; readonly children: readonly Inline[] }
	| { readonly type: "strike"; readonly children: readonly Inline[] }
	| { readonly type: "spoiler"; readonly children: readonly Inline[] }
	| { readonly type: "code"; readonly text: string }
	| { readonly type: "link"; readonly href: string; readonly children: readonly Inline[] }
	| { readonly type: "image"; readonly src: string; readonly alt: string };

/** One source line's worth of inline nodes. */
export type InlineLine = readonly Inline[];

/** One table row: one inline sequence per cell. */
export type TableRow = readonly InlineLine[];

/** How a list item was written, which decides its rendered bullet. */
export type ListMarker = "bullet" | "ordered" | "task-todo" | "task-done";

/** One list item, with its nesting depth and continuation lines. */
export interface ListItem {
	/** Rendered bullet/checkbox kind. */
	readonly marker: ListMarker;
	/** Source ordinal for ordered lists. */
	readonly ordinal: number | undefined;
	/** Nesting depth, 0 for a top-level item, capped at {@link MAX_LIST_DEPTH}. */
	readonly depth: number;
	/** The item's own lines; a grounded continuation line joins them here. */
	readonly lines: readonly InlineLine[];
}

/** One block-level element. */
export type Block =
	| { readonly type: "heading"; readonly level: number; readonly line: InlineLine }
	| { readonly type: "paragraph"; readonly lines: readonly InlineLine[] }
	| { readonly type: "code"; readonly language: string | undefined; readonly lines: readonly string[] }
	| { readonly type: "quote"; readonly expandable: boolean; readonly lines: readonly InlineLine[] }
	| { readonly type: "list"; readonly items: readonly ListItem[] }
	| { readonly type: "rule" }
	| { readonly type: "table"; readonly header: TableRow; readonly rows: readonly TableRow[] };

/** Emphasis-like inline markup, longest delimiter first so `**` wins over `*`. */
const INLINE_MARKUP: readonly {
	readonly marker: string;
	readonly type: "strong" | "emphasis" | "strike" | "spoiler";
	/** Whether the marker needs whitespace on both outside edges (the `_` rule). */
	readonly outsideWhitespaceOnly: boolean;
}[] = [
	{ marker: "**", type: "strong", outsideWhitespaceOnly: false },
	{ marker: "__", type: "strong", outsideWhitespaceOnly: true },
	{ marker: "~~", type: "strike", outsideWhitespaceOnly: false },
	{ marker: "||", type: "spoiler", outsideWhitespaceOnly: false },
	{ marker: "*", type: "emphasis", outsideWhitespaceOnly: false },
	{ marker: "_", type: "emphasis", outsideWhitespaceOnly: true },
];

/** Link schemes a message may carry; anything else stays literal text. */
const LINK_SCHEMES = ["http:", "https:", "mailto:", "tg:"];

/** A scheme-looking prefix, used to reject `javascript:` and `data:` images. */
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Whether a character counts as part of a word for underscore emphasis. */
function isWordChar(value: string | undefined): boolean {
	return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

/** Whether a character is inline whitespace. */
function isSpace(value: string | undefined): boolean {
	return value === undefined || /\s/.test(value);
}

/** A backslash escape may quote any ASCII punctuation, per CommonMark. */
function isEscapable(value: string | undefined): boolean {
	return value !== undefined && /[!-/:-@[-`{-~]/.test(value);
}

/** Length of the run of `char` starting at `index`. */
function runLength(source: string, index: number, char: string): number {
	let length = 0;
	while (source[index + length] === char) length += 1;
	return length;
}

/**
 * Turn one line (or a list of them) into inline nodes.
 *
 * The scanner is linear and never backtracks over work it already emitted: at
 * each position it either recognizes a construct and jumps past it, or copies a
 * character into the pending text node.
 * @param source - the raw line content, without its block marker.
 * @param depth - current markup nesting, to bound pathological input.
 * @returns the inline nodes of that line.
 */
export function parseInline(source: string, depth = 0): Inline[] {
	const nodes: Inline[] = [];
	let text = "";
	let index = 0;

	const flush = (): void => {
		if (text !== "") {
			nodes.push({ type: "text", text });
			text = "";
		}
	};

	while (index < source.length) {
		const char = source[index] ?? "";

		if (char === "\\" && isEscapable(source[index + 1])) {
			text += source[index + 1] ?? "";
			index += 2;
			continue;
		}

		if (char === "`") {
			const span = matchCodeSpan(source, index);
			if (span !== undefined) {
				flush();
				nodes.push({ type: "code", text: span.text });
				index = span.end;
				continue;
			}
		}

		if (char === "!" && source[index + 1] === "[") {
			const image = matchImage(source, index);
			if (image !== undefined) {
				flush();
				nodes.push(image.node);
				index = image.end;
				continue;
			}
		}

		if (char === "[") {
			const link = matchLink(source, index, depth);
			if (link !== undefined) {
				flush();
				nodes.push(link.node);
				index = link.end;
				continue;
			}
		}

		if (char === "<") {
			const autolink = matchAutolink(source, index);
			if (autolink !== undefined) {
				flush();
				nodes.push(autolink.node);
				index = autolink.end;
				continue;
			}
		}

		const markup = matchMarkup(source, index, depth);
		if (markup !== undefined) {
			flush();
			nodes.push(markup.node);
			index = markup.end;
			continue;
		}

		text += char;
		index += 1;
	}

	flush();
	return nodes;
}

/** A code span opened at `index`, when a matching run closes it. */
function matchCodeSpan(source: string, index: number): { text: string; end: number } | undefined {
	const run = runLength(source, index, "`");
	let at = source.indexOf("`".repeat(run), index + run);
	while (at !== -1) {
		if (runLength(source, at, "`") === run) {
			const raw = source.slice(index + run, at);
			// CommonMark strips one space from each side when both are present, which
			// is how `` ` x ` `` can show a padded span without the padding.
			const padded = raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "";
			return { text: padded ? raw.slice(1, -1) : raw, end: at + run };
		}
		at = source.indexOf("`".repeat(run), at + 1);
	}
	return undefined;
}

/** `![alt](src)` at `index`, when the target is a path or a web URL. */
function matchImage(source: string, index: number): { node: Inline; end: number } | undefined {
	const label = matchBalanced(source, index + 1, "[", "]");
	if (label === undefined || source[label.end] !== "(") return undefined;
	const target = matchBalanced(source, label.end, "(", ")");
	if (target === undefined) return undefined;
	const src = unwrapUrl(target.value);
	if (src === "" || !isSafeImageSrc(src)) return undefined;
	return { node: { type: "image", src, alt: plainText(parseInline(label.value)) }, end: target.end };
}

/** `[text](href)` at `index`, when the scheme is one Telegram may link to. */
function matchLink(source: string, index: number, depth: number): { node: Inline; end: number } | undefined {
	if (depth >= MAX_INLINE_DEPTH) return undefined;
	const label = matchBalanced(source, index, "[", "]");
	if (label === undefined || source[label.end] !== "(") return undefined;
	const target = matchBalanced(source, label.end, "(", ")");
	if (target === undefined) return undefined;
	const href = unwrapUrl(target.value);
	if (!isLinkHref(href)) return undefined;
	return { node: { type: "link", href, children: parseInline(label.value, depth + 1) }, end: target.end };
}

/** `<https://…>` at `index`; `<b>not html</b>` fails the scheme test and stays text. */
function matchAutolink(source: string, index: number): { node: Inline; end: number } | undefined {
	const close = source.indexOf(">", index + 1);
	if (close === -1) return undefined;
	const value = source.slice(index + 1, close);
	if (value === "" || /\s/.test(value) || !isLinkHref(value)) return undefined;
	return {
		node: { type: "link", href: value, children: [{ type: "text", text: value }] },
		end: close + 1,
	};
}

/** Emphasis-like markup opened at `index`. */
function matchMarkup(
	source: string,
	index: number,
	depth: number,
): { node: Inline; end: number } | undefined {
	if (depth >= MAX_INLINE_DEPTH) return undefined;
	const char = source[index] ?? "";
	if (char !== "*" && char !== "_" && char !== "~" && char !== "|") return undefined;
	const run = runLength(source, index, char);
	// A run of three or more is not a delimiter this subset understands
	// (`***bold***`, `~~~`): the first character becomes text and the rest is
	// rescanned. Falling straight from `**` to `*` is what would otherwise turn
	// `** not bold **` into italics.
	if (run > 2) return undefined;
	for (const spec of INLINE_MARKUP) {
		if (spec.marker.length !== run || !source.startsWith(spec.marker, index)) continue;
		// The underscore family exists to be conservative: `snake_case` must not
		// become italics, so the opener needs a non-word character before it and the
		// closer needs whitespace (or the end of the line) after it.
		if (spec.outsideWhitespaceOnly && isWordChar(source[index - 1])) continue;
		const open = index + spec.marker.length;
		const close = findClose(source, open, spec);
		if (close === -1) continue;
		const inner = source.slice(open, close);
		return {
			node: { type: spec.type, children: parseInline(inner, depth + 1) },
			end: close + spec.marker.length,
		};
	}
	return undefined;
}

/** The first acceptable closer for one delimiter spec, or -1. */
function findClose(
	source: string,
	from: number,
	spec: (typeof INLINE_MARKUP)[number],
): number {
	let at = source.indexOf(spec.marker, from);
	while (at !== -1) {
		const inner = source.slice(from, at);
		const after = source[at + spec.marker.length];
		const acceptable =
			inner !== "" &&
			!isSpace(inner[0]) &&
			!isSpace(inner[inner.length - 1]) &&
			(!spec.outsideWhitespaceOnly || isSpace(after));
		if (acceptable) return at;
		at = source.indexOf(spec.marker, at + 1);
	}
	return -1;
}

/**
 * The balanced run starting at `index`, with `open`/`close` as its delimiters.
 *
 * One scanner serves both link labels (`[…]`, which nest) and link targets
 * (`(…)`), because the only difference between them is the delimiter pair.
 * @param source - the line being scanned.
 * @param index - where the opening delimiter must sit.
 * @param open - the opening delimiter.
 * @param close - the closing delimiter.
 * @returns the delimiters' content and the index just past the closer.
 */
function matchBalanced(
	source: string,
	index: number,
	open: string,
	close: string,
): { value: string; end: number } | undefined {
	if (source[index] !== open) return undefined;
	let depth = 0;
	let at = index;
	while (at < source.length) {
		const char = source[at] ?? "";
		if (char === "\\") {
			// A backslash escapes the next character, so neither delimiter counts.
			at += 2;
			continue;
		}
		if (char === open) depth += 1;
		if (char === close) {
			depth -= 1;
			if (depth === 0) return { value: source.slice(index + 1, at), end: at + 1 };
		}
		at += 1;
	}
	return undefined;
}

/** Strip the optional `<…>` wrapper and unbalanced angle brackets from a target. */
function unwrapUrl(value: string): string {
	const trimmed = value.trim();
	const angled = /^<(.+)>$/.exec(trimmed);
	return (angled?.[1] ?? trimmed).trim();
}

/** Whether a link target is a scheme Telegram should make tappable. */
function isLinkHref(href: string): boolean {
	const lower = href.toLowerCase();
	return LINK_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * Whether an image target is safe to hand to an uploader.
 *
 * Local paths (`chart.png`, `/tmp/w/chart.png`) and web URLs are fine; anything
 * with another scheme — `javascript:`, `data:` — is refused and the source stays
 * literal text, so a message can never smuggle a URL the bridge would treat as
 * something other than an image.
 */
function isSafeImageSrc(src: string): boolean {
	const scheme = SCHEME_PATTERN.exec(src)?.[0]?.toLowerCase();
	if (scheme === undefined) return true;
	return scheme === "http:" || scheme === "https:";
}

/** Flatten inline nodes back to plain text, for alt attributes. */
export function plainText(nodes: readonly Inline[]): string {
	let out = "";
	for (const node of nodes) {
		switch (node.type) {
			case "text":
			case "code":
				out += node.text;
				break;
			case "image":
				out += node.alt;
				break;
			default:
				out += plainText(node.children);
		}
	}
	return out;
}

/** A fence opening: its character, length and info string. */
interface Fence {
	readonly char: "`" | "~";
	readonly length: number;
	readonly language: string | undefined;
}

/** Recognize a fence opening line, if it is one. */
function matchFence(line: string): Fence | undefined {
	const match = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
	const marker = match?.[1];
	if (marker === undefined) return undefined;
	const char = marker[0] === "~" ? "~" : "`";
	// A backtick fence's info string may not contain a backtick, so an inline code
	// span at the start of a line is not mistaken for a fence.
	if (char === "`" && line.includes("`", (match?.[0].length ?? 0))) return undefined;
	const info = (match?.[2] ?? "").trim();
	return { char, length: marker.length, language: info === "" ? undefined : (info.split(/\s+/)[0] ?? undefined) };
}

/** Whether a line closes a fence opened with `fence`. */
function closesFence(line: string, fence: Fence): boolean {
	const pattern = fence.char === "`" ? /^\s{0,3}(`{3,})\s*$/ : /^\s{0,3}(~{3,})\s*$/;
	const match = pattern.exec(line);
	const marker = match?.[1];
	return marker !== undefined && marker.length >= fence.length;
}

/** The level and content of an ATX heading line. */
function matchHeading(line: string): { level: number; content: string } | undefined {
	const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(line);
	if (match === undefined || match === null) return undefined;
	const content = (match[2] ?? "").replace(/\s+#+\s*$/, "");
	return { level: (match[1] ?? "#").length, content };
}

/** Whether a line is a thematic break (`---`, `***`, `___`, spaced variants). */
function isRule(line: string): boolean {
	const stripped = line.trim().replaceAll(/\s+/g, "");
	if (stripped.length < 3) return false;
	const char = stripped[0];
	if (char !== "-" && char !== "*" && char !== "_") return false;
	return stripped.split("").every((value) => value === char);
}

/** A quote line's content, or undefined when the line is not a quote. */
function matchQuote(line: string): string | undefined {
	const match = /^\s{0,3}>\s?(.*)$/.exec(line);
	return match?.[1];
}

/** A list item line's parts, or undefined when the line is not an item. */
function matchListItem(line: string): { indent: number; ordered: boolean; ordinal: number; content: string } | undefined {
	const match = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/.exec(line);
	if (match === null) return undefined;
	const marker = match[2];
	if (marker === undefined) return undefined;
	const indent = (match[1] ?? "").replaceAll("\t", "    ").length;
	const ordered = /\d/.test(marker);
	const content = match[3] ?? "";
	const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
	const taskMarker =
		task === null ? undefined : (task[1] ?? " ").toLowerCase() === "x" ? "task-done" : "task-todo";
	return {
		indent,
		ordered,
		ordinal: ordered ? Number.parseInt(marker, 10) : 0,
		content: task?.[2] ?? content,
		...(taskMarker === undefined ? {} : { task: taskMarker }),
	};
}

/** GFM table delimiter row (`| --- | :--: |`). */
function isTableDelimiter(line: string): boolean {
	return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

/** Split a table row into cells, honouring `\|` escapes. */
function splitRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	for (let at = 0; at < trimmed.length; at += 1) {
		const char = trimmed[at] ?? "";
		if (char === "\\" && trimmed[at + 1] === "|") {
			current += "|";
			at += 1;
			continue;
		}
		if (char === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current.trim());
	return cells;
}

/**
 * Parse agent prose into blocks.
 * @param text - the raw assistant text, already the turn's own output.
 * @returns the blocks in source order; empty input yields no blocks.
 */
export function parseMarkdown(text: string): Block[] {
	const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const blocks: Block[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line.trim() === "") {
			index += 1;
			continue;
		}

		const fence = matchFence(line);
		if (fence !== undefined) {
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !closesFence(lines[index] ?? "", fence)) {
				body.push(lines[index] ?? "");
				index += 1;
			}
			index += 1;
			blocks.push({ type: "code", language: fence.language, lines: body });
			continue;
		}

		const heading = matchHeading(line);
		if (heading !== undefined) {
			blocks.push({ type: "heading", level: heading.level, line: parseInline(heading.content) });
			index += 1;
			continue;
		}

		if (isRule(line)) {
			blocks.push({ type: "rule" });
			index += 1;
			continue;
		}

		if (matchQuote(line) !== undefined) {
			const body: InlineLine[] = [];
			while (index < lines.length) {
				const content = matchQuote(lines[index] ?? "");
				if (content === undefined) break;
				body.push(parseInline(content));
				index += 1;
			}
			blocks.push({ type: "quote", expandable: body.length > EXPANDABLE_QUOTE_LINES, lines: body });
			continue;
		}

		if (matchListItem(line) !== undefined) {
			const parsed = readList(lines, index);
			blocks.push({ type: "list", items: parsed.items });
			index = parsed.end;
			continue;
		}

		if (line.includes("|") && isTableDelimiter(lines[index + 1] ?? "")) {
			const parsed = readTable(lines, index);
			blocks.push(parsed.table);
			index = parsed.end;
			continue;
		}

		const paragraph: InlineLine[] = [];
		while (index < lines.length) {
			const current = lines[index] ?? "";
			if (current.trim() === "" || startsBlock(current, lines[index + 1] ?? "")) break;
			paragraph.push(parseInline(current));
			index += 1;
		}
		blocks.push({ type: "paragraph", lines: paragraph });
	}

	return blocks;
}

/** Whether a line opens a block, ending the paragraph being collected. */
function startsBlock(line: string, next: string): boolean {
	if (matchFence(line) !== undefined) return true;
	if (matchHeading(line) !== undefined) return true;
	if (isRule(line)) return true;
	if (matchQuote(line) !== undefined) return true;
	if (matchListItem(line) !== undefined) return true;
	return line.includes("|") && isTableDelimiter(next);
}

/** Read a whole list starting at `index`. */
function readList(lines: readonly string[], index: number): { items: ListItem[]; end: number } {
	const items: ListItem[] = [];
	let at = index;
	while (at < lines.length) {
		const line = lines[at] ?? "";
		const parsed = matchListItem(line);
		if (parsed === undefined) break;
		const depth = Math.min(MAX_LIST_DEPTH, Math.floor(parsed.indent / 2));
		const lines2: InlineLine[] = [parseInline(parsed.content)];
		const marker: ListMarker =
			"task" in parsed && typeof parsed.task === "string"
				? (parsed.task as ListMarker)
				: parsed.ordered
					? "ordered"
					: "bullet";
		items.push({ marker, ordinal: parsed.ordered ? parsed.ordinal : undefined, depth, lines: lines2 });
		at += 1;
		// A grounded continuation line belongs to the item; anything else ends it.
		while (at < lines.length) {
			const continuation = lines[at] ?? "";
			if (continuation.trim() === "" || matchListItem(continuation) !== undefined) break;
			const indent = continuation.length - continuation.trimStart().length;
			if (indent <= parsed.indent) break;
			lines2.push(parseInline(continuation.trim()));
			at += 1;
		}
		// A blank line followed by another item keeps the list alive only when the
		// next item exists; a blank line before prose ends it.
		if ((lines[at] ?? "").trim() === "" && matchListItem(lines[at + 1] ?? "") !== undefined) {
			at += 1;
			continue;
		}
		if (matchListItem(lines[at] ?? "") !== undefined) continue;
		break;
	}
	return { items, end: at };
}

/** Read a pipe table starting at `index`. */
function readTable(lines: readonly string[], index: number): { table: Block; end: number } {
	const header = splitRow(lines[index] ?? "").map((cell) => parseInline(cell));
	const rows: TableRow[] = [];
	let at = index + 2;
	while (at < lines.length) {
		const line = lines[at] ?? "";
		if (line.trim() === "" || !line.includes("|")) break;
		const cells = splitRow(line).map((cell) => parseInline(cell));
		// Ragged rows are padded so every rendered row keeps the same column count.
		while (cells.length < header.length) cells.push([]);
		rows.push(cells.slice(0, header.length));
		at += 1;
	}
	return { table: { type: "table", header, rows }, end: at };
}
