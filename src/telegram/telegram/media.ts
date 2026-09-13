/**
 * Classifying outbound media, and keeping one turn inside Telegram's ceilings.
 *
 * A reply can carry media from three places — a `![alt](src)` in the agent's
 * prose, a file the agent explicitly `present`ed, and an image block attached to
 * a tool result — and all three arrive here as one {@link MediaSource}. What
 * each becomes is decided by exactly two things Telegram enforces and one we do:
 *
 * - **Upload ceilings.** `sendPhoto` takes at most 10 MB and rejects a photo
 *   whose width+height exceeds 10000 or whose aspect ratio exceeds 20:1;
 *   `sendDocument` takes at most 50 MB. A source that cannot be a photo is not
 *   refused — it is sent as a document, which is the difference between the user
 *   getting their chart and getting an apology.
 * - **The working directory.** A local path is only allowed to resolve inside the
 *   session's cwd, after `realpath`, so `..` traversal and a symlink pointing out
 *   of the tree are both refusals rather than an upload of `/etc/passwd`. This is
 *   the guard the first phase's plan asked for: an agent must not be able to post
 *   the machine's contents into a chat.
 * - **The turn budget.** Ten items and 50 MB per turn, deduplicated by identity,
 *   because a chat is capped at roughly one message per second and a turn that
 *   produced a hundred images is better summarized than dumped.
 *
 * Nothing here sends anything or formats user-facing text: a refusal is a code
 * plus a detail string, and the caller renders it. File system and attachment
 * access arrive as {@link MediaIo} so a test needs no disk and no store.
 * @module dsh-telegram/telegram/media
 */
import { basename, isAbsolute, join, sep } from "node:path";

/** Telegram's `sendPhoto` ceiling for an uploaded photo. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Telegram's `sendDocument` ceiling for an uploaded file. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** How many media items one reply may deliver. */
export const MAX_MEDIA_PER_TURN = 10;

/** How many bytes of media one reply may deliver in total. */
export const MAX_MEDIA_TURN_BYTES = 50 * 1024 * 1024;

/** Largest allowed `width + height` for a photo, per `sendPhoto`. */
export const PHOTO_MAX_DIMENSION_SUM = 10_000;

/** Largest allowed width:height ratio for a photo, per `sendPhoto`. */
export const PHOTO_MAX_RATIO = 20;

/** The slice of an `ImageAttachmentRef` this module reads. */
export interface AttachmentRefLike {
	/** Opaque store identity; also the natural dedupe key. */
	readonly attachmentId: string;
	/** Declared media type, e.g. `image/png`. */
	readonly mediaType: string;
	/** Declared encoded byte length. */
	readonly bytes: number;
	/** Intrinsic width in pixels, when the store recorded one. */
	readonly width?: number | undefined;
	/** Intrinsic height in pixels, when the store recorded one. */
	readonly height?: number | undefined;
	/** Display name stripped of local path information. */
	readonly name?: string | undefined;
}

/** Where one piece of media came from. */
export type MediaSource =
	| { readonly kind: "attachment"; readonly ref: AttachmentRefLike }
	| { readonly kind: "path"; readonly path: string }
	| { readonly kind: "url"; readonly url: string };

/**
 * Why a source could not be sent.
 *
 * The caller maps each code to one line of text; the codes are the contract, the
 * wording is not. `unreadable` carries the failing operation's error name in
 * `detail`, which is the only diagnostic available once the bytes are gone.
 */
export type MediaRefusalCode =
	| "outside-cwd"
	| "missing"
	| "not-file"
	| "too-large"
	| "unreadable"
	| "not-media";

/** What to send for one source: an upload, a URL, or a refusal. */
export type MediaPlan =
	| { readonly kind: "photo"; readonly bytes: Uint8Array; readonly name: string; readonly mediaType: string }
	| { readonly kind: "photo-url"; readonly url: string }
	| { readonly kind: "document"; readonly bytes: Uint8Array; readonly name: string }
	| { readonly kind: "refused"; readonly code: MediaRefusalCode; readonly detail: string };

/** Every filesystem/attachment operation the resolver needs, injected so tests need no real disk. */
export interface MediaIo {
	/** The session working directory; every local path must resolve inside it. */
	readonly cwd: string;
	/** `realpath` of an existing path, or undefined when it does not exist. */
	resolveRealPath(path: string): Promise<string | undefined>;
	/** Whether the real path is a regular file. */
	isFile(path: string): Promise<boolean>;
	/** Byte length of the real path, or undefined when it cannot be stat'ed. */
	statSize(path: string): Promise<number | undefined>;
	/** Read the real path's bytes. */
	readFile(path: string): Promise<Uint8Array>;
	/** Verified bytes of a stored attachment. */
	readAttachment(ref: AttachmentRefLike, signal?: AbortSignal): Promise<Uint8Array>;
}

/** One mebibyte, the unit Telegram's own ceilings are expressed in. */
const MEBIBYTE = 1024 * 1024;

/**
 * Human byte count for a user-facing notice.
 *
 * Rounds into the next unit rather than printing `1024 kB`: a size that is about
 * to be refused reads better as `1.0 MB` than as a four-digit kilobyte count.
 * @param bytes - the byte length to describe.
 * @returns e.g. `12 B`, `812 kB`, `1.1 MB`.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${String(bytes)} B`;
	const kilobytes = Math.round(bytes / 1024);
	if (kilobytes < 1024) return `${String(kilobytes)} kB`;
	return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
}

/** Extensions Telegram renders as a picture when uploaded to `sendPhoto`. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/**
 * Lowercase image extension without the dot.
 *
 * Only the extension decides: a `.png` that is really a PDF is Telegram's
 * problem when it decodes the upload, and sniffing bytes here would mean reading
 * a file we are about to refuse on size. A leading dot names a dotfile rather
 * than an extension, so `.png` has none.
 * @param path - a file name or path.
 * @returns `png` / `jpg` / `jpeg` / `webp` / `gif`, or undefined for anything else.
 */
export function imageExtensionOf(path: string): string | undefined {
	const base = path.split(/[/\\]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const extension = base.slice(dot + 1).toLowerCase();
	return IMAGE_EXTENSIONS.has(extension) ? extension : undefined;
}

/**
 * Whether an http(s) URL's pathname ends in a recognized image extension.
 *
 * Telegram fetches a URL-sent photo itself, so a page URL would be downloaded
 * and then rejected as not-a-photo; requiring the extension keeps that failure
 * out of the chat. Query strings are ignored because only the pathname counts.
 * @param url - the candidate URL.
 * @returns whether it can be handed to `sendPhoto` as a URL.
 */
export function isImageUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	return imageExtensionOf(parsed.pathname) !== undefined;
}

/** Refuse a source with one code and the detail the notice prints. */
function refuse(code: MediaRefusalCode, detail: string): MediaPlan {
	return { kind: "refused", code, detail };
}

/**
 * The failing operation's error name.
 *
 * A refusal's detail is the only diagnostic left once the bytes are gone, and
 * `name` is the one field every thrown value can be relied on to describe.
 * @param error - the value a `MediaIo` operation threw.
 * @returns the error's name, or `Error` for a thrown non-error.
 */
function errorName(error: unknown): string {
	const name = (error as { name?: unknown } | undefined)?.name;
	return typeof name === "string" && name !== "" ? name : "Error";
}

/** Display extensions for the media types Telegram can deliver. */
const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/**
 * Media types for the image extensions a local file may carry.
 *
 * Derived from {@link MEDIA_TYPE_EXTENSIONS} so the two directions cannot drift;
 * `jpg` is the one alias a file may carry that the media-type direction cannot
 * express, so it is added by hand.
 */
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
	...Object.fromEntries(
		Object.entries(MEDIA_TYPE_EXTENSIONS)
			// A GIF is deliberately absent: uploading one as a photo would flatten the
			// animation, so it travels as a document (see `resolveAttachment`).
			.filter(([mediaType]) => mediaType !== "image/gif")
			.map(([mediaType, extension]) => [extension, mediaType]),
	),
	jpg: "image/jpeg",
};

/**
 * Whether `sendPhoto` will accept this attachment.
 *
 * Dimensions are optional metadata: a store that recorded none cannot rule the
 * photo out, and Telegram's own decode is the final word — so an unmeasured
 * image is attempted as a photo rather than demoted. A zero dimension is treated
 * as unrecorded for the same reason.
 * @param ref - the durable attachment reference.
 * @returns whether the photo path applies.
 */
function fitsPhoto(ref: AttachmentRefLike): boolean {
	if (ref.bytes > MAX_PHOTO_BYTES) return false;
	const { width, height } = ref;
	if (width === undefined || height === undefined || width <= 0 || height <= 0) return true;
	if (width + height > PHOTO_MAX_DIMENSION_SUM) return false;
	return Math.max(width, height) / Math.min(width, height) <= PHOTO_MAX_RATIO;
}

/**
 * Resolve one source into the media to send.
 *
 * Never throws: every i/o failure becomes a refusal, because a reply that
 * carried one unreadable file must still deliver its text and its other media.
 * @param source - the attachment, local path, or URL.
 * @param io - filesystem and attachment access.
 * @returns the upload to send, a URL to send, or why it was refused.
 */
export async function resolveMedia(source: MediaSource, io: MediaIo): Promise<MediaPlan> {
	switch (source.kind) {
		case "url":
			return isImageUrl(source.url) ? { kind: "photo-url", url: source.url } : refuse("not-media", source.url);
		case "attachment":
			return await resolveAttachment(source.ref, io);
		default:
			return await resolvePath(source.path, io);
	}
}

/**
 * Classify a stored attachment from its declared metadata.
 *
 * The reference is content-addressed and digest-verified by the store, so its
 * `bytes` field is the truth about the upload size; nothing is read until the
 * size ceiling has already been applied.
 * @param ref - the durable reference recorded in the session log.
 * @param io - attachment byte access.
 * @returns the upload to send, or why it was refused.
 */
async function resolveAttachment(ref: AttachmentRefLike, io: MediaIo): Promise<MediaPlan> {
	const extension = MEDIA_TYPE_EXTENSIONS[ref.mediaType];
	if (extension === undefined) return refuse("not-media", ref.mediaType);
	if (ref.bytes > MAX_UPLOAD_BYTES) return refuse("too-large", formatBytes(ref.bytes));
	const name = ref.name ?? `image.${extension}`;
	let bytes: Uint8Array;
	try {
		bytes = await io.readAttachment(ref);
	} catch (error) {
		return refuse("unreadable", errorName(error));
	}
	// A GIF uploaded as a photo loses its animation, so it travels as a file.
	if (ref.mediaType === "image/gif" || !fitsPhoto(ref)) return { kind: "document", bytes, name };
	return { kind: "photo", bytes, name, mediaType: ref.mediaType };
}

/**
 * Whether a resolved path is the working directory itself or sits beneath it.
 *
 * The separator matters: `/root/out` must not be read as living inside
 * `/root/outside`. Both sides are already `realpath`-resolved, so a symlink
 * cannot make an outside file look inside.
 * @param path - the resolved candidate.
 * @param root - the resolved working directory.
 * @returns whether the candidate is inside the root.
 */
function isInside(path: string, root: string): boolean {
	if (path === root) return true;
	return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Classify a local path, refusing anything that is not inside the session cwd.
 *
 * A path leaves the working directory only by being refused: `..` traversal and
 * a symlink pointing outside are the same refusal, and neither reads a byte. The
 * working directory itself is resolved too, so a symlinked cwd (a home directory
 * on another volume, say) compares link-free on both sides.
 * @param path - the path as written by the agent.
 * @param io - filesystem access.
 * @returns the upload to send, or why it was refused.
 */
async function resolvePath(path: string, io: MediaIo): Promise<MediaPlan> {
	try {
		const candidate = isAbsolute(path) ? path : join(io.cwd, path);
		const real = await io.resolveRealPath(candidate);
		if (real === undefined) return refuse("missing", path);
		const root = (await io.resolveRealPath(io.cwd)) ?? io.cwd;
		if (!isInside(real, root)) return refuse("outside-cwd", real);
		if (!(await io.isFile(real))) return refuse("not-file", real);

		const size = await io.statSize(real);
		if (size !== undefined && size > MAX_UPLOAD_BYTES) return refuse("too-large", formatBytes(size));
		const name = basename(real);
		const bytes = await io.readFile(real);
		// The file can grow between the stat and the read, so the ceiling is applied
		// to what was actually read as well.
		if (bytes.byteLength > MAX_UPLOAD_BYTES) return refuse("too-large", formatBytes(bytes.byteLength));
		const mediaType = EXTENSION_MEDIA_TYPES[imageExtensionOf(name) ?? ""];
		if (mediaType !== undefined && bytes.byteLength <= MAX_PHOTO_BYTES) {
			return { kind: "photo", bytes, name, mediaType };
		}
		return { kind: "document", bytes, name };
	} catch (error) {
		return refuse("unreadable", errorName(error));
	}
}

/**
 * One reply's media budget: how many items, how many bytes, and which identities.
 *
 * A refused charge changes nothing, which is what makes the ledger safe to
 * consult per item while planning: an item over the byte budget does not eat the
 * slot a later, smaller item could have used. Identities — an attachment id, a
 * resolved path, or a name-and-size pair — are remembered only for admitted
 * items, so the same image reaching the planner twice is sent once.
 */
export class MediaLedger {
	readonly #maxItems: number;
	readonly #maxBytes: number;
	readonly #keys = new Set<string>();
	#items = 0;
	#bytes = 0;

	/**
	 * @param limits - overrides for the per-turn defaults, for tests and callers
	 * that need a tighter budget than the deployment's.
	 */
	constructor(
		limits?: { readonly maxItems?: number | undefined; readonly maxBytes?: number | undefined } | undefined,
	) {
		this.#maxItems = limits?.maxItems ?? MAX_MEDIA_PER_TURN;
		this.#maxBytes = limits?.maxBytes ?? MAX_MEDIA_TURN_BYTES;
	}

	/**
	 * Charge one planned item against the turn.
	 * @param key - the item's dedupe identity.
	 * @param bytes - how many bytes it will upload; a URL photo charges zero.
	 * @returns `{ok: true}`, or a stable reason: `duplicate`, `too-many-items`,
	 * `turn-bytes-exceeded`.
	 */
	admit(key: string, bytes: number): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
		if (this.#keys.has(key)) return { ok: false, reason: "duplicate" };
		if (this.#items + 1 > this.#maxItems) return { ok: false, reason: "too-many-items" };
		if (this.#bytes + bytes > this.#maxBytes) return { ok: false, reason: "turn-bytes-exceeded" };
		this.#keys.add(key);
		this.#items += 1;
		this.#bytes += bytes;
		return { ok: true };
	}
}
