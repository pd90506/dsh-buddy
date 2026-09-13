/**
 * Media classification: what one source becomes, and what the turn budget allows.
 *
 * Every judgement here exists to keep a send from failing at the API: Telegram
 * rejects an oversized photo, refuses a body it cannot parse, and a 50 MB upload
 * per turn is a rate-limit hazard rather than a feature. The refusals are
 * therefore part of the contract — the caller turns each code into one line of
 * text, so a refused item is still *reported*, never silently dropped.
 *
 * No test touches a real disk or a real attachment store: `MediaIo` is the seam.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_MEDIA_TURN_BYTES,
	MAX_PHOTO_BYTES,
	MAX_UPLOAD_BYTES,
	MediaLedger,
	formatBytes,
	imageExtensionOf,
	isImageUrl,
	resolveMedia,
	type AttachmentRefLike,
	type MediaIo,
} from "../../src/telegram/telegram/media.ts";

/** Bytes a stub file or attachment holds; only their length is ever judged. */
function bytesOf(size: number): Uint8Array {
	return new Uint8Array(size);
}

/**
 * One entry in the fake filesystem.
 *
 * `size` may deliberately disagree with `bytes`, and `null` means the entry
 * cannot be measured at all — the two ways a stat and a read can differ.
 */
type FakeEntry =
	| { readonly kind: "file"; readonly bytes: Uint8Array; readonly size?: number | null }
	| { readonly kind: "directory" };

/** A fake `MediaIo` and the reads it observed, so "refused without reading" is provable. */
interface FakeIo extends MediaIo {
	/** Paths handed to `readFile`, in order. */
	readonly reads: string[];
	/** Attachment ids handed to `readAttachment`, in order. */
	readonly attachmentReads: string[];
}

/** A named error, the way Node reports a failing syscall. */
function ioError(name: string): Error {
	const error = new Error(`${name}: failed`);
	error.name = name;
	return error;
}

/**
 * An in-memory `MediaIo`.
 *
 * `links` are symlinks: a path present there resolves to the target without ever
 * appearing in `tree`, which is exactly how a link escaping the working directory
 * is modelled. The error maps name paths (or `"*"` for every path) whose call
 * must throw, so the unreadable branch is reachable without a real i/o failure.
 * @param tree - every path that exists, keyed by absolute path.
 * @param options - symlinks, the attachment store, and scripted failures.
 * @returns the fake io plus its read log.
 */
function fakeIo(
	tree: Record<string, FakeEntry> = {},
	options: {
		readonly cwd?: string;
		readonly links?: Record<string, string>;
		readonly attachments?: Record<string, Uint8Array>;
		readonly readErrors?: Record<string, string>;
		readonly statErrors?: Record<string, string>;
		readonly realPathErrors?: Record<string, string>;
	} = {},
): FakeIo {
	const reads: string[] = [];
	const attachmentReads: string[] = [];
	const links = options.links ?? {};
	const attachments = options.attachments ?? {};
	const readErrors = options.readErrors ?? {};
	const statErrors = options.statErrors ?? {};
	const realPathErrors = options.realPathErrors ?? {};
	const sizeOf = (path: string): number | undefined => {
		const entry = tree[path];
		if (entry === undefined || entry.kind !== "file") return undefined;
		if (entry.size === null) return undefined;
		return entry.size ?? entry.bytes.byteLength;
	};
	return {
		cwd: options.cwd ?? "/root",
		reads,
		attachmentReads,
		resolveRealPath: async (path: string) => {
			const failure = realPathErrors[path] ?? realPathErrors["*"];
			if (failure !== undefined) throw ioError(failure);
			return links[path] ?? (tree[path] === undefined ? undefined : path);
		},
		isFile: async (path: string) => tree[path]?.kind === "file",
		statSize: async (path: string) => {
			const failure = statErrors[path] ?? statErrors["*"];
			if (failure !== undefined) throw ioError(failure);
			return sizeOf(path);
		},
		readFile: async (path: string) => {
			reads.push(path);
			const failure = readErrors[path] ?? readErrors["*"];
			if (failure !== undefined) throw ioError(failure);
			const entry = tree[path];
			if (entry === undefined || entry.kind !== "file") throw ioError("ENOENT");
			return entry.bytes;
		},
		readAttachment: async (ref: AttachmentRefLike) => {
			attachmentReads.push(ref.attachmentId);
			const failure = readErrors[ref.attachmentId] ?? readErrors["*"];
			if (failure !== undefined) throw ioError(failure);
			// The real store's reference declares its exact byte length, so an entry is
			// only needed when a test wants the declared and actual sizes to disagree.
			return attachments[ref.attachmentId] ?? bytesOf(ref.bytes);
		},
	};
}

test("formatBytes names bytes, kilobytes and megabytes the way a notice reads", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(1023), "1023 B");
	assert.equal(formatBytes(1024), "1 kB");
	assert.equal(formatBytes(812 * 1024), "812 kB");
	assert.equal(formatBytes(1_048_576), "1.0 MB");
	assert.equal(formatBytes(1_129_474), "1.1 MB");
	// One byte short of a mebibyte must not print as "1024 kB".
	assert.equal(formatBytes(1_048_575), "1.0 MB");
});

test("imageExtensionOf recognizes only the image extensions Telegram can send", () => {
	assert.equal(imageExtensionOf("chart.png"), "png");
	assert.equal(imageExtensionOf("/tmp/a/b/Photo.JPEG"), "jpeg");
	assert.equal(imageExtensionOf("shot.webp"), "webp");
	assert.equal(imageExtensionOf("anim.gif"), "gif");
	assert.equal(imageExtensionOf("notes.txt"), undefined);
	assert.equal(imageExtensionOf("archive.tar.gz"), undefined);
	assert.equal(imageExtensionOf("report.PDF"), undefined);
	// A dotfile is a name, not an extension.
	assert.equal(imageExtensionOf(".png"), undefined);
	assert.equal(imageExtensionOf("noext"), undefined);
});

test("isImageUrl accepts only http(s) URLs whose pathname claims an image", () => {
	assert.equal(isImageUrl("https://example.com/a/chart.png"), true);
	assert.equal(isImageUrl("http://example.com/x.JPG?v=2"), true);
	assert.equal(isImageUrl("https://example.com/page"), false);
	assert.equal(isImageUrl("https://example.com/page.html"), false);
	assert.equal(isImageUrl("ftp://example.com/chart.png"), false);
	assert.equal(isImageUrl("not a url"), false);
	// A file:// path is not something Telegram can fetch.
	assert.equal(isImageUrl("file:///tmp/chart.png"), false);
});

test("resolveMedia hands an image URL to Telegram instead of downloading it", async () => {
	const url = "https://example.com/a/chart.png?v=2";
	const plan = await resolveMedia({ kind: "url", url }, fakeIo());
	assert.deepEqual(plan, { kind: "photo-url", url });
});

test("resolveMedia refuses a URL that is not an image, leaving the caller to keep it as a link", async () => {
	const plan = await resolveMedia({ kind: "url", url: "https://example.com/page" }, fakeIo());
	assert.equal(plan.kind, "refused");
	assert.equal(plan.kind === "refused" ? plan.code : "", "not-media");
});

/** An attachment reference with sane defaults, overridden per test. */
function ref(overrides: Partial<AttachmentRefLike> = {}): AttachmentRefLike {
	return {
		attachmentId: "sha256:abcd",
		mediaType: "image/png",
		bytes: 1000,
		width: 800,
		height: 600,
		...overrides,
	};
}

test("resolveMedia sends a stored PNG attachment as a photo with its recorded bytes", async () => {
	const stored = bytesOf(1129);
	const io = fakeIo({}, { attachments: { "sha256:abcd": stored } });
	const plan = await resolveMedia({ kind: "attachment", ref: ref({ bytes: 1129 }) }, io);
	assert.deepEqual(plan, { kind: "photo", bytes: stored, name: "image.png", mediaType: "image/png" });
	assert.deepEqual(io.attachmentReads, ["sha256:abcd"]);
});

test("resolveMedia keeps the attachment's own display name", async () => {
	const plan = await resolveMedia(
		{ kind: "attachment", ref: ref({ name: "codex-generated.png" }) },
		fakeIo(),
	);
	assert.equal(plan.kind === "photo" ? plan.name : "", "codex-generated.png");
});

test("resolveMedia sends a photo-shaped attachment whose dimensions the store never recorded", async () => {
	const plan = await resolveMedia(
		{ kind: "attachment", ref: ref({ width: undefined, height: undefined }) },
		fakeIo(),
	);
	assert.equal(plan.kind, "photo");
});

test("resolveMedia treats exactly ten megabytes as a photo and one byte more as a document", async () => {
	const atCeiling = await resolveMedia(
		{ kind: "attachment", ref: ref({ bytes: MAX_PHOTO_BYTES }) },
		fakeIo(),
	);
	assert.equal(atCeiling.kind, "photo");

	const overCeiling = await resolveMedia(
		{ kind: "attachment", ref: ref({ bytes: MAX_PHOTO_BYTES + 1 }) },
		fakeIo(),
	);
	assert.equal(overCeiling.kind, "document");
});

test("resolveMedia downgrades an attachment photo that breaks sendPhoto's dimension rules", async () => {
	const tooWide = await resolveMedia(
		{ kind: "attachment", ref: ref({ width: 9_000, height: 1_001 }) },
		fakeIo(),
	);
	assert.equal(tooWide.kind, "document");

	const tooElongated = await resolveMedia(
		{ kind: "attachment", ref: ref({ width: 2_000, height: 50 }) },
		fakeIo(),
	);
	assert.equal(tooElongated.kind, "document");
});

test("resolveMedia sends an animated GIF attachment as a document so the animation survives", async () => {
	const plan = await resolveMedia(
		{ kind: "attachment", ref: ref({ mediaType: "image/gif", name: "loop.gif" }) },
		fakeIo(),
	);
	assert.equal(plan.kind, "document");
	assert.equal(plan.kind === "document" ? plan.name : "", "loop.gif");
});

test("resolveMedia refuses an attachment past the fifty megabyte upload ceiling without reading it", async () => {
	const io = fakeIo();
	const plan = await resolveMedia(
		{ kind: "attachment", ref: ref({ bytes: MAX_UPLOAD_BYTES + 1 }) },
		io,
	);
	assert.equal(plan.kind === "refused" ? plan.code : "", "too-large");
	assert.deepEqual(io.attachmentReads, []);
});

test("resolveMedia refuses a media type Telegram cannot deliver", async () => {
	const plan = await resolveMedia(
		{ kind: "attachment", ref: ref({ mediaType: "application/pdf" }) },
		fakeIo(),
	);
	assert.equal(plan.kind === "refused" ? plan.code : "", "not-media");
});

test("resolveMedia reports an attachment whose bytes cannot be read as unreadable, naming the error", async () => {
	const io = fakeIo({}, { readErrors: { "sha256:abcd": "AttachmentError" } });
	const plan = await resolveMedia({ kind: "attachment", ref: ref() }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "unreadable");
	assert.equal(plan.kind === "refused" ? plan.detail : "", "AttachmentError");
});

test("resolveMedia resolves a relative path against the session cwd and sends it as a photo", async () => {
	const chart = bytesOf(2048);
	const io = fakeIo({ "/root/out/chart.png": { kind: "file", bytes: chart } });
	const plan = await resolveMedia({ kind: "path", path: "out/chart.png" }, io);
	assert.deepEqual(plan, { kind: "photo", bytes: chart, name: "chart.png", mediaType: "image/png" });
	assert.deepEqual(io.reads, ["/root/out/chart.png"]);
});

test("resolveMedia accepts an absolute path that stays inside the working directory", async () => {
	const shot = bytesOf(10);
	const io = fakeIo({ "/root/shots/a.jpg": { kind: "file", bytes: shot } });
	const plan = await resolveMedia({ kind: "path", path: "/root/shots/a.jpg" }, io);
	assert.deepEqual(plan, { kind: "photo", bytes: shot, name: "a.jpg", mediaType: "image/jpeg" });
});

test("resolveMedia refuses a relative path that climbs out of the working directory", async () => {
	const io = fakeIo({ "/etc/passwd": { kind: "file", bytes: bytesOf(20) } });
	const plan = await resolveMedia({ kind: "path", path: "../../etc/passwd" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "outside-cwd");
	assert.deepEqual(io.reads, []);
});

test("resolveMedia refuses an absolute path outside the working directory", async () => {
	const io = fakeIo({ "/etc/passwd": { kind: "file", bytes: bytesOf(20) } });
	const plan = await resolveMedia({ kind: "path", path: "/etc/passwd" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "outside-cwd");
	assert.deepEqual(io.reads, []);
});

test("resolveMedia refuses a symlink whose realpath escapes the working directory", async () => {
	const io = fakeIo(
		{ "/outside/secret.png": { kind: "file", bytes: bytesOf(64) } },
		{ links: { "/root/link.png": "/outside/secret.png" } },
	);
	const plan = await resolveMedia({ kind: "path", path: "link.png" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "outside-cwd");
	assert.deepEqual(io.reads, []);
});

test("resolveMedia refuses a path that does not exist", async () => {
	const io = fakeIo();
	const plan = await resolveMedia({ kind: "path", path: "out/gone.png" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "missing");
	assert.deepEqual(io.reads, []);
});

test("resolveMedia refuses a directory even when its name claims an image", async () => {
	const io = fakeIo({ "/root/folder.png": { kind: "directory" } });
	const plan = await resolveMedia({ kind: "path", path: "folder.png" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "not-file");
	assert.deepEqual(io.reads, []);
});

test("resolveMedia sends an image past ten megabytes as a document rather than dropping it", async () => {
	const big = bytesOf(MAX_PHOTO_BYTES + 1);
	const io = fakeIo({ "/root/big.png": { kind: "file", bytes: big } });
	const plan = await resolveMedia({ kind: "path", path: "big.png" }, io);
	assert.equal(plan.kind, "document");
	assert.equal(plan.kind === "document" ? plan.name : "", "big.png");
});

test("resolveMedia refuses a file past the fifty megabyte ceiling without reading it", async () => {
	const io = fakeIo({
		"/root/huge.bin": { kind: "file", bytes: bytesOf(4), size: MAX_UPLOAD_BYTES + 1 },
	});
	const plan = await resolveMedia({ kind: "path", path: "huge.bin" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "too-large");
	assert.deepEqual(io.reads, []);
});

test("resolveMedia sends an animated GIF file as a document so the animation survives", async () => {
	const loop = bytesOf(4096);
	const io = fakeIo({ "/root/loop.gif": { kind: "file", bytes: loop } });
	const plan = await resolveMedia({ kind: "path", path: "loop.gif" }, io);
	assert.deepEqual(plan, { kind: "document", bytes: loop, name: "loop.gif" });
});

test("resolveMedia sends a presented file that is not an image as a document", async () => {
	const report = bytesOf(900);
	const io = fakeIo({ "/root/report.pdf": { kind: "file", bytes: report } });
	const plan = await resolveMedia({ kind: "path", path: "report.pdf" }, io);
	assert.deepEqual(plan, { kind: "document", bytes: report, name: "report.pdf" });
});

test("resolveMedia judges a file whose size cannot be stat'ed by the bytes it read", async () => {
	const chart = bytesOf(2048);
	const io = fakeIo({ "/root/chart.png": { kind: "file", bytes: chart, size: null } });
	const plan = await resolveMedia({ kind: "path", path: "chart.png" }, io);
	assert.equal(plan.kind, "photo");
	assert.deepEqual(io.reads, ["/root/chart.png"]);
});

test("resolveMedia reports a failing stat as unreadable, naming the error", async () => {
	const io = fakeIo(
		{ "/root/chart.png": { kind: "file", bytes: bytesOf(64) } },
		{ statErrors: { "/root/chart.png": "EACCES" } },
	);
	const plan = await resolveMedia({ kind: "path", path: "chart.png" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "unreadable");
	assert.equal(plan.kind === "refused" ? plan.detail : "", "EACCES");
});

test("resolveMedia reports a failing read as unreadable, naming the error", async () => {
	const io = fakeIo(
		{ "/root/chart.png": { kind: "file", bytes: bytesOf(64) } },
		{ readErrors: { "/root/chart.png": "EIO" } },
	);
	const plan = await resolveMedia({ kind: "path", path: "chart.png" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "unreadable");
	assert.equal(plan.kind === "refused" ? plan.detail : "", "EIO");
});

test("MediaLedger admits an item once and reports its identity as a duplicate afterwards", () => {
	const ledger = new MediaLedger();
	assert.deepEqual(ledger.admit("sha256:abcd", 100), { ok: true });
	assert.deepEqual(ledger.admit("sha256:abcd", 100), { ok: false, reason: "duplicate" });
});

test("MediaLedger defaults to ten items per turn and reports the eleventh", () => {
	const ledger = new MediaLedger();
	for (let index = 0; index < 10; index += 1) {
		assert.deepEqual(ledger.admit(`image-${String(index)}`, 1), { ok: true });
	}
	assert.deepEqual(ledger.admit("image-10", 1), { ok: false, reason: "too-many-items" });
});

test("MediaLedger defaults to fifty megabytes per turn and reports the byte past it", () => {
	const ledger = new MediaLedger();
	assert.deepEqual(ledger.admit("first", MAX_MEDIA_TURN_BYTES), { ok: true });
	assert.deepEqual(ledger.admit("second", 1), { ok: false, reason: "turn-bytes-exceeded" });
});

test("MediaLedger lets a refused charge keep neither a slot nor a byte of the budget", () => {
	const ledger = new MediaLedger({ maxItems: 2, maxBytes: 100 });
	assert.deepEqual(ledger.admit("a", 60), { ok: true });
	assert.deepEqual(ledger.admit("b", 50), { ok: false, reason: "turn-bytes-exceeded" });
	// The refused item cost nothing: the last slot still fits 40 bytes exactly.
	assert.deepEqual(ledger.admit("c", 40), { ok: true });
	// Both slots are spent now, and the byte budget is exactly full.
	assert.deepEqual(ledger.admit("d", 0), { ok: false, reason: "too-many-items" });
});

test("MediaLedger does not remember a key that was refused for budget", () => {
	const ledger = new MediaLedger({ maxBytes: 100 });
	assert.deepEqual(ledger.admit("a", 100), { ok: true });
	assert.deepEqual(ledger.admit("b", 50), { ok: false, reason: "turn-bytes-exceeded" });
	// Nothing about the refused charge was recorded, so the same key may come back
	// smaller and be admitted.
	assert.deepEqual(ledger.admit("b", 0), { ok: true });
});

test("resolveMedia reports a failing realpath as unreadable instead of throwing", async () => {
	const io = fakeIo({}, { realPathErrors: { "/root/chart.png": "ELOOP" } });
	const plan = await resolveMedia({ kind: "path", path: "chart.png" }, io);
	assert.equal(plan.kind === "refused" ? plan.code : "", "unreadable");
	assert.equal(plan.kind === "refused" ? plan.detail : "", "ELOOP");
});
