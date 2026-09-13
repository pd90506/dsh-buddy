/**
 * Orchestration: turn parts in, Bot API calls out.
 *
 * The pieces that matter here are order and restraint. Order: a chart appears
 * where the sentence pointing at it appears, not in a pile at the end, and the
 * `(i/n)` counter counts *text* messages so an image between two chunks does not
 * make the numbering lie. Restraint: a file outside the working directory, an
 * image the size of a video, a turn that produced twenty pictures — each one
 * becomes a line of text that says so, never a silent hole and never an upload
 * from somewhere the agent was not allowed to read.
 *
 * Nothing in this file touches a disk or a network: the media resolver's whole
 * world is injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planReply, type Outbound } from "../../src/telegram/telegram/deliver.ts";
import type { AttachmentRefLike, MediaIo } from "../../src/telegram/telegram/media.ts";
import type { TurnPart } from "../../src/telegram/session.ts";

/** A byte array of a given length, tagged so tests can tell images apart. */
function bytes(length: number, tag = 1): Uint8Array {
	const value = new Uint8Array(length);
	value.fill(tag);
	return value;
}

/** An in-memory filesystem and attachment store behind the resolver's seam. */
function world(options: {
	files?: Record<string, Uint8Array> | undefined;
	attachments?: Record<string, Uint8Array> | undefined;
	cwd?: string | undefined;
} = {}): { io: MediaIo; files: Record<string, Uint8Array>; attachments: Record<string, Uint8Array> } {
	const files = options.files ?? {};
	const attachments = options.attachments ?? {};
	const cwd = options.cwd ?? "/w";
	const absolute = (path: string): string => (path.startsWith("/") ? path : `${cwd}/${path}`);
	return {
		files,
		attachments,
		io: {
			cwd,
			resolveRealPath: async (path: string) => {
				const resolved = absolute(path);
				return resolved in files ? resolved : undefined;
			},
			isFile: async (path: string) => absolute(path) in files,
			statSize: async (path: string) => files[absolute(path)]?.byteLength,
			readFile: async (path: string) => files[absolute(path)] ?? new Uint8Array(),
			readAttachment: async (ref: AttachmentRefLike) => attachments[ref.attachmentId] ?? new Uint8Array(),
		},
	};
}

/** Default options: everything on, which is what the settings ship with. */
function options(io: MediaIo, overrides: Partial<Parameters<typeof planReply>[1]> = {}): Parameters<typeof planReply>[1] {
	return { io, mediaDelivery: "all", renderMarkdown: true, ...overrides };
}

/** The text outbounds, joined, for assertions that do not care about splitting. */
function textOf(outbound: readonly Outbound[]): string {
	return outbound
		.flatMap((item) => (item.kind === "text" ? [item.plain] : []))
		.join("\n");
}

test("plain text becomes one message, with no indicator", async () => {
	const { io } = world();
	const out = await planReply([{ kind: "text", text: "**hi** there" }], options(io));
	assert.equal(out.length, 1);
	// `plain` is what the reader sees; the markup lives in `html`.
	assert.equal(textOf(out), "hi there");
	assert.equal(out[0]?.kind === "text" && out[0].html, "<b>hi</b> there");
});

test("a long reply is split, and every text chunk carries its ordinal", async () => {
	const { io } = world();
	const source = Array.from({ length: 60 }, (_, index) => `line ${String(index)}`).join("\n");
	const out = await planReply([{ kind: "text", text: source }], options(io, { limit: 200 }));
	const texts = out.filter((item) => item.kind === "text");
	assert.ok(texts.length > 1, "expected a split");
	texts.forEach((item, index) => {
		if (item.kind !== "text") return;
		assert.match(item.plain, new RegExp(` \\(${String(index + 1)}/${String(texts.length)}\\)$`));
		assert.match(item.html, new RegExp(` \\(${String(index + 1)}/${String(texts.length)}\\)$`));
	});
});

test("two separate assistant messages are two messages, not a numbered split", async () => {
	// Each assistant message is its own part now, the way DSH shows them as
	// separate bubbles. Distinct messages are not a length-split, so they carry no
	// (i/n) counter — that counter is only for one message Telegram had to cut.
	const { io } = world();
	const out = await planReply(
		[{ kind: "text", text: "first thought" }, { kind: "text", text: "second thought" }],
		options(io),
	);
	const texts = out.filter((item) => item.kind === "text");
	assert.equal(texts.length, 2, "two messages, one per assistant message");
	assert.deepEqual(
		texts.map((item) => (item.kind === "text" ? item.plain : "")),
		["first thought", "second thought"],
		"no (i/n) suffix on distinct messages",
	);
});

test("an image written into a sentence is delivered where the sentence says it is", async () => {
	const { io } = world({ files: { "/w/chart.png": bytes(2048) } });
	const out = await planReply(
		[{ kind: "text", text: "看图 ![季度图](chart.png) 谢谢" }],
		options(io),
	);
	assert.deepEqual(
		out.map((item) => item.kind),
		["text", "photo", "text"],
	);
	const photo = out[1];
	assert.equal(photo?.kind === "photo" && photo.caption, "季度图");
	assert.equal(photo?.kind === "photo" && photo.name, "chart.png");
	// Two text messages around the image, so they are numbered as such.
	assert.equal(textOf(out).replace(/ \(\d+\/\d+\)/g, "").replaceAll("\n", ""), "看图  谢谢");
});

test("a generated image comes from the attachment store, without a path", async () => {
	const { io } = world({ attachments: { "sha256:aa": bytes(4096) } });
	const part: TurnPart = {
		kind: "media",
		via: "tool",
		source: { kind: "attachment", attachment: { attachmentId: "sha256:aa", mediaType: "image/png", bytes: 4096, name: "generated.png" } },
		caption: "generated.png",
	};
	const out = await planReply([part], options(io));
	assert.equal(out.length, 1);
	const photo = out[0];
	assert.equal(photo?.kind, "photo");
	assert.equal(photo?.kind === "photo" && photo.bytes.byteLength, 4096);
	assert.equal(photo?.kind === "photo" && photo.caption, "generated.png");
});

test("a presented file becomes a document, with the declaration as its caption", async () => {
	const { io } = world({ files: { "/w/reports/summary.md": bytes(300) } });
	const out = await planReply(
		[{ kind: "media", via: "presented", source: { kind: "path", path: "reports/summary.md" }, caption: "本周汇总" }],
		options(io),
	);
	assert.equal(out.length, 1);
	const document = out[0];
	assert.equal(document?.kind, "document");
	assert.equal(document?.kind === "document" && document.caption, "本周汇总");
	assert.equal(document?.kind === "document" && document.name, "summary.md");
});

test("a file outside the working directory is refused with a line of text, not silently", async () => {
	// The resolver normalizes `..` before asking, which is exactly what a real
	// filesystem does when the agent writes a traversal instead of a path.
	const { io } = world({ files: { "/elsewhere/secret.png": bytes(10) } });
	const out = await planReply(
		[{ kind: "media", via: "presented", source: { kind: "path", path: "../../elsewhere/secret.png" } }],
		options(io),
	);
	assert.equal(out.length, 1);
	assert.equal(out[0]?.kind, "text");
	assert.match(textOf(out), /outside the working directory/);
	assert.match(textOf(out), /secret\.png/);
});

test("an over-sized image becomes a document, and an over-sized document is refused", async () => {
	const big = world({ files: { "/w/big.png": new Uint8Array(11 * 1024 * 1024), "/w/huge.zip": new Uint8Array(51 * 1024 * 1024) } });
	const out = await planReply(
		[
			{ kind: "media", via: "presented", source: { kind: "path", path: "big.png" } },
			{ kind: "media", via: "presented", source: { kind: "path", path: "huge.zip" } },
		],
		options(big.io),
	);
	assert.deepEqual(
		out.map((item) => item.kind),
		["document", "text"],
	);
	assert.match(textOf(out), /over Telegram's size limit/);
});

test("a gif stays a document so it keeps animating", async () => {
	const { io } = world({ files: { "/w/demo.gif": bytes(5000) } });
	const out = await planReply([{ kind: "media", via: "presented", source: { kind: "path", path: "demo.gif" } }], options(io));
	assert.equal(out[0]?.kind, "document");
});

test("two caption-less photos in a row become one album, and captioned ones stay single", async () => {
	const files = { "/w/a.png": bytes(100, 1), "/w/b.png": bytes(100, 2), "/w/c.png": bytes(100, 3) };
	const { io } = world({ files });
	const out = await planReply(
		[
			{ kind: "media", via: "presented", source: { kind: "path", path: "a.png" } },
			{ kind: "media", via: "presented", source: { kind: "path", path: "b.png" } },
			{ kind: "media", via: "presented", source: { kind: "path", path: "c.png" }, caption: "带标题" },
		],
		options(io),
	);
	assert.deepEqual(
		out.map((item) => item.kind),
		["album", "photo"],
	);
	const album = out[0];
	assert.equal(album?.kind === "album" && album.items.length, 2);
});

test("mediaDelivery presented drops tool images and inline images but keeps deliveries", async () => {
	const { io } = world({
		files: { "/w/chart.png": bytes(10) },
		attachments: { "sha256:aa": bytes(20) },
	});
	const out = await planReply(
		[
			{ kind: "text", text: "![inline](chart.png)" },
			{ kind: "media", via: "tool", source: { kind: "attachment", attachment: { attachmentId: "sha256:aa", mediaType: "image/png", bytes: 20 } } },
			{ kind: "media", via: "presented", source: { kind: "path", path: "chart.png" } },
		],
		options(io, { mediaDelivery: "presented" }),
	);
	assert.deepEqual(
		out.map((item) => item.kind),
		["photo"],
	);
});

test("mediaDelivery off sends text only, with no complaints about the media it dropped", async () => {
	const { io } = world({ files: {}, attachments: {} });
	const out = await planReply(
		[
			{ kind: "text", text: "before" },
			{ kind: "media", via: "presented", source: { kind: "path", path: "missing.png" } },
			{ kind: "text", text: "after" },
		],
		options(io, { mediaDelivery: "off" }),
	);
	// The two text parts stay two messages: with the media dropped, the reader gets
	// the prose that surrounded it, with no complaint about what is missing.
	assert.deepEqual(
		out.map((item) => item.kind),
		["text", "text"],
	);
	assert.equal(textOf(out).replace(/ \(\d+\/\d+\)/g, ""), "before\nafter");
});

test("the same image twice is sent once, and the duplicate is not worth a complaint", async () => {
	const { io } = world({ files: { "/w/chart.png": bytes(100) } });
	const out = await planReply(
		[
			{ kind: "media", via: "presented", source: { kind: "path", path: "chart.png" } },
			{ kind: "media", via: "presented", source: { kind: "path", path: "/w/chart.png" } },
		],
		options(io),
	);
	assert.deepEqual(
		out.map((item) => item.kind),
		["photo"],
	);
});

test("a turn over the media budget reports what it could not send", async () => {
	const files: Record<string, Uint8Array> = {};
	for (let index = 0; index < 12; index += 1) files[`/w/img${String(index)}.png`] = bytes(100, index);
	const { io } = world({ files });
	const parts: TurnPart[] = Array.from({ length: 12 }, (_, index) => ({
		kind: "media",
		via: "presented",
		source: { kind: "path", path: `img${String(index)}.png` },
	}));
	const out = await planReply(parts, options(io));
	const sent = out.filter((item) => item.kind === "album" || item.kind === "photo").length;
	assert.ok(sent < 12, "the budget must bite");
	assert.match(textOf(out), /\d+ more media item\(s\) not sent/);
});

test("renderMarkdown off falls back to escaped text and no inline markup", async () => {
	const { io } = world();
	const out = await planReply([{ kind: "text", text: "**not bold**" }], options(io, { renderMarkdown: false }));
	assert.equal(out[0]?.kind === "text" && out[0].html, "**not bold**");
});

test("an unreadable file is reported instead of crashing the reply", async () => {
	const io: MediaIo = {
		cwd: "/w",
		resolveRealPath: async (path) => path,
		isFile: async () => true,
		statSize: async () => 10,
		readFile: async () => {
			throw Object.assign(new Error("boom"), { name: "EIO" });
		},
		readAttachment: async () => {
			throw new Error("nope");
		},
	};
	const out = await planReply(
		[
			{ kind: "text", text: "here" },
			{ kind: "media", via: "presented", source: { kind: "path", path: "/w/broken.png" } },
		],
		options(io),
	);
	assert.deepEqual(
		out.map((item) => item.kind),
		["text", "text"],
	);
	assert.match(textOf(out), /unreadable/);
});

test("an image-only turn produces media and no placeholder text", async () => {
	const { io } = world({ files: { "/w/only.png": bytes(50) } });
	const out = await planReply([{ kind: "media", via: "presented", source: { kind: "path", path: "only.png" } }], options(io));
	assert.deepEqual(
		out.map((item) => item.kind),
		["photo"],
	);
});

test("a web image spends a turn slot and is deduplicated by its URL (R27, AC-20)", async () => {
	const { io } = world();
	const same = { kind: "text" as const, text: "![a](https://example.com/chart.png) ![b](https://example.com/chart.png)" };
	const out = await planReply([same], options(io));
	assert.deepEqual(
		out.map((item) => item.kind),
		["photo-url", "text"],
	);
	// The second reference is a duplicate of the first and says so only by being
	// absent: the same picture twice is not worth a message.
	const urls = out.filter((item) => item.kind === "photo-url");
	assert.equal(urls.length, 1);
	assert.equal(urls[0]?.kind === "photo-url" && urls[0].url, "https://example.com/chart.png");
	assert.equal(urls[0]?.kind === "photo-url" && urls[0].caption, "a");
	assert.equal(textOf(out).trim(), "");
});

test("more web images than the turn allows are reported, not silently dropped (R27)", async () => {
	const { io } = world();
	const many = Array.from({ length: 12 }, (_, index) => `![i${String(index)}](https://example.com/${String(index)}.png)`).join(" ");
	const out = await planReply([{ kind: "text", text: many }], options(io));
	const photos = out.filter((item) => item.kind === "photo-url").length;
	assert.equal(photos, 10);
	assert.match(textOf(out), /2 more media item\(s\) not sent/);
});
