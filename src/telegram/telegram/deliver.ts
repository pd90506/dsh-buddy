/**
 * Turning a turn's parts into the exact sequence of Bot API calls.
 *
 * This is the layer that decides *what the user sees*, and its whole job is
 * order and restraint:
 *
 * - **Order.** Text is split for Telegram, images are uploaded, and both leave in
 *   the order the agent wrote them, so a chart appears where the sentence
 *   pointing at it appears. The `(i/n)` counter counts *text* messages, so an
 *   image between two chunks never makes the numbering lie.
 * - **Restraint.** A file outside the session's working directory, an image past
 *   Telegram's photo limits, a turn that produced twenty pictures, a duplicate of
 *   something already sent — each is decided here, and each failure becomes one
 *   line of text rather than a silent hole. Silence would leave the reader
 *   believing the agent forgot to attach something.
 *
 * Everything the resolver needs is injected ({@link MediaIo}), which is what lets
 * the whole policy be tested without a disk, a network or a bot token.
 * @module dsh-buddy/telegram/telegram/deliver
 */
import { basename } from "node:path";
import type { MediaDelivery } from "../config.ts";
import type { TurnPart } from "../session.ts";
import {
	MediaLedger,
	isImageUrl,
	resolveMedia,
	type MediaIo,
	type MediaPlan,
	type MediaRefusalCode,
	type MediaSource,
} from "./media.ts";
import { DOCUMENT_MEDIA_TYPE, MEDIA_GROUP_MAX_ITEMS, MEDIA_GROUP_MIN_ITEMS } from "./api.ts";
import {
	TELEGRAM_TEXT_LIMIT,
	escapeHtml,
	escapeHtmlAttribute,
	ordinalSuffix,
	planMarkdown,
	planPlain,
	type TextChunk,
} from "./render.ts";

/** Telegram's caption ceiling, in UTF-16 units after entity parsing. */
export const CAPTION_LIMIT = 1024;

/** What the user's settings allow to be sent. */
type MediaVia = "presented" | "tool" | "markdown";

/** One photo inside an album. */
export interface AlbumPhoto {
	/** The file's bytes. */
	readonly bytes: Uint8Array;
	/** Upload filename. */
	readonly name: string;
	/** Declared media type. */
	readonly mediaType: string;
}

/** One thing to send, in order. */
export type Outbound =
	| { readonly kind: "text"; readonly html: string; readonly plain: string }
	| {
			readonly kind: "photo";
			readonly bytes: Uint8Array;
			readonly name: string;
			readonly mediaType: string;
			readonly caption?: string | undefined;
	  }
	| { readonly kind: "photo-url"; readonly url: string; readonly caption?: string | undefined }
	| { readonly kind: "document"; readonly bytes: Uint8Array; readonly name: string; readonly caption?: string | undefined }
	| { readonly kind: "album"; readonly items: readonly AlbumPhoto[] };

/** Collaborators of {@link planReply}. */
export interface DeliverOptions {
	/** Filesystem and attachment access, with the session's working directory. */
	readonly io: MediaIo;
	/** What the settings allow. */
	readonly mediaDelivery: MediaDelivery;
	/** Whether agent prose is interpreted as Markdown. */
	readonly renderMarkdown: boolean;
	/** Per-message ceiling, overridable for tests. */
	readonly limit?: number | undefined;
	/** Shared budget, when a caller wants to span several turns. */
	readonly ledger?: MediaLedger | undefined;
}

/** A candidate before it is resolved: text ready to send, or media to look up. */
type Candidate =
	| { readonly kind: "text"; readonly html: string; readonly plain: string }
	| { readonly kind: "media"; readonly source: MediaSource; readonly caption?: string | undefined };

/** A media candidate after resolution, plus the notices a refusal becomes. */
type ResolvedItem =
	| { readonly kind: "text"; readonly html: string; readonly plain: string }
	| { readonly kind: "photo"; readonly bytes: Uint8Array; readonly name: string; readonly mediaType: string; readonly caption?: string | undefined }
	| { readonly kind: "photo-url"; readonly url: string; readonly caption?: string | undefined }
	| { readonly kind: "document"; readonly bytes: Uint8Array; readonly name: string; readonly caption?: string | undefined }
	| { readonly kind: "notice"; readonly text: string };

/** Human label per refusal code; the detail from the resolver is appended. */
const REFUSAL_LABELS: Record<MediaRefusalCode, string> = {
	"outside-cwd": "outside the working directory",
	missing: "file not found",
	"not-file": "not a regular file",
	"too-large": "over Telegram's size limit",
	unreadable: "unreadable",
	"not-media": "not sendable media",
};

/**
 * Plan one turn's delivery.
 * @param parts - the turn's text and media, in log order.
 * @param options - access, settings, and optional overrides.
 * @returns the outbound items, in send order.
 */
export async function planReply(parts: readonly TurnPart[], options: DeliverOptions): Promise<Outbound[]> {
	const limit = options.limit ?? TELEGRAM_TEXT_LIMIT;
	const ledger = options.ledger ?? new MediaLedger();
	const candidates = candidatesOf(parts, options, limit);

	const resolved: ResolvedItem[] = [];
	let skippedByBudget = 0;

	for (const candidate of candidates) {
		if (candidate.kind === "text") {
			resolved.push(candidate);
			continue;
		}
		const plan = await resolveOne(candidate.source, options.io);
		const caption = captionOf(candidate.caption);
		if (plan.kind === "refused") {
			resolved.push({
				kind: "notice",
				text: `[Not sent: ${labelOf(candidate.source)} (${REFUSAL_LABELS[plan.code]}${plan.detail === "" ? "" : `: ${plan.detail}`})]`,
			});
			continue;
		}
		if (plan.kind === "photo-url") {
			// A URL photo costs no bytes but still occupies a message: it is charged a
			// slot, and the URL is its identity, so the same link twice is sent once.
			const admitted = ledger.admit(plan.url.toLowerCase(), 0);
			if (!admitted.ok) {
				if (admitted.reason !== "duplicate") skippedByBudget += 1;
				continue;
			}
			resolved.push({ kind: "photo-url", url: plan.url, ...(caption === undefined ? {} : { caption }) });
			continue;
		}
		const bytes = plan.bytes.byteLength;
		// One key space across sources: an image that was generated, copied into the
		// workspace and then presented is one image, and the name-plus-size pair is
		// what those two descriptions have in common.
		const verdict = ledger.admit(`${basename(plan.name).toLowerCase()}|${String(bytes)}`, bytes);
		if (!verdict.ok) {
			// A duplicate is the same picture twice, which is not worth a message;
			// a spent budget is information the reader needs.
			if (verdict.reason !== "duplicate") skippedByBudget += 1;
			continue;
		}
		resolved.push({
			kind: plan.kind,
			bytes: plan.bytes,
			name: plan.name,
			mediaType: plan.kind === "photo" ? plan.mediaType : DOCUMENT_MEDIA_TYPE,
			...(caption === undefined ? {} : { caption }),
		});
	}

	const outbound = assemble(resolved);
	if (skippedByBudget > 0) {
		outbound.push(notice(`(${String(skippedByBudget)} more media item(s) not sent)`));
	}
	number(outbound);
	return outbound;
}

/** Turn the turn's parts into text chunks and media candidates. */
function candidatesOf(parts: readonly TurnPart[], options: DeliverOptions, limit: number): Candidate[] {
	const candidates: Candidate[] = [];
	for (const part of parts) {
		if (part.kind === "text") {
			const plans = options.renderMarkdown ? planMarkdown(part.text, { limit }) : textOnly(part.text, limit);
			for (const plan of plans) {
				if (plan.kind === "text") {
					for (const chunk of plan.chunks) candidates.push({ kind: "text", html: chunk.html, plain: chunk.plain });
					continue;
				}
				if (!allows(options.mediaDelivery, "markdown")) continue;
				// A web image without an image extension is not something Telegram will
				// fetch as a photo, so it stays a link rather than becoming a complaint.
				if (/^https?:\/\//i.test(plan.src) && !isImageUrl(plan.src)) {
					const label = plan.alt === "" ? plan.src : plan.alt;
					candidates.push({
						kind: "text",
						html: `<a href="${escapeHtmlAttribute(plan.src)}">${escapeHtml(label)}</a>`,
						plain: label,
					});
					continue;
				}
				candidates.push({
					kind: "media",
					source: sourceOf(plan.src),
					...(plan.alt === "" ? {} : { caption: plan.alt }),
				});
			}
			continue;
		}
		if (!allows(options.mediaDelivery, part.via)) continue;
		candidates.push({
			kind: "media",
			source: sourceOfPart(part),
			...(part.caption === undefined ? {} : { caption: part.caption }),
		});
	}
	return candidates;
}

/** Non-Markdown mode: text chunks only, no media extraction. */
function textOnly(text: string, limit: number): { readonly kind: "text"; readonly chunks: readonly TextChunk[] }[] {
	return [{ kind: "text", chunks: planPlain(text, limit) }];
}

/** Whether the settings allow one kind of media. */
function allows(mode: MediaDelivery, via: MediaVia): boolean {
	if (mode === "off") return false;
	if (mode === "presented") return via === "presented";
	return true;
}

/** The resolver source for a markdown image: a web URL or a local path. */
function sourceOf(src: string): MediaSource {
	return /^https?:\/\//i.test(src) ? { kind: "url", url: src } : { kind: "path", path: src };
}

/** The resolver source for a media part the session folder produced. */
function sourceOfPart(part: Extract<TurnPart, { kind: "media" }>): MediaSource {
	return part.source.kind === "attachment"
		? { kind: "attachment", ref: part.source.attachment }
		: { kind: "path", path: part.source.path };
}

/** Resolve one source, converting an unexpected throw into a refusal. */
async function resolveOne(source: MediaSource, io: MediaIo): Promise<MediaPlan> {
	try {
		return await resolveMedia(source, io);
	} catch (error) {
		// The resolver is documented not to throw; if a future backend does, the
		// reply must still go out, minus that one image.
		return { kind: "refused", code: "unreadable", detail: (error as Error).name };
	}
}

/** A label for a refusal: the file's name, the URL, or the attachment name. */
function labelOf(source: MediaSource): string {
	if (source.kind === "url") return source.url;
	if (source.kind === "path") return basename(source.path);
	// The attachment's own name, never the resolver's detail: that carries a size or
	// a media type, and `image/svg+xml` basenames to nonsense.
	const name = source.ref.name;
	return name === undefined || name === "" ? "attachment" : name;
}

/** The caption to send, escaped and cut to Telegram's ceiling. */
function captionOf(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const text = raw.trim();
	if (text === "") return undefined;
	const cut = text.length > CAPTION_LIMIT ? `${text.slice(0, CAPTION_LIMIT - 1)}…` : text;
	return escapeHtml(cut);
}

/** A one-line notice to the reader. */
function notice(text: string): Outbound {
	return { kind: "text", html: escapeHtml(text), plain: text };
}

/** Assemble resolved items, grouping consecutive caption-less photos into albums. */
function assemble(resolved: readonly ResolvedItem[]): Outbound[] {
	const outbound: Outbound[] = [];
	let album: AlbumPhoto[] = [];

	const flush = (): void => {
		if (album.length >= MEDIA_GROUP_MIN_ITEMS) {
			outbound.push({ kind: "album", items: album });
		} else {
			const only = album[0];
			if (only !== undefined) outbound.push({ kind: "photo", ...only });
		}
		album = [];
	};

	for (const item of resolved) {
		if (item.kind === "photo" && item.caption === undefined) {
			album.push({ bytes: item.bytes, name: item.name, mediaType: item.mediaType });
			if (album.length >= MEDIA_GROUP_MAX_ITEMS) flush();
			continue;
		}
		flush();
		switch (item.kind) {
			case "text":
				outbound.push({ kind: "text", html: item.html, plain: item.plain });
				break;
			case "notice":
				outbound.push(notice(item.text));
				break;
			case "photo":
				outbound.push(item);
				break;
			case "photo-url":
				outbound.push(item);
				break;
			case "document":
				outbound.push(item);
				break;
		}
	}
	flush();
	return outbound;
}

/**
 * Number the text messages of one reply.
 *
 * Telegram's per-message ceiling is what forces the split, so the reader is told
 * which piece they are missing: `(2/3)` on every text message, and only text
 * messages — an image between two of them is not a "part" of the text.
 * @param outbound - the outbound sequence, numbered in place.
 */
function number(outbound: Outbound[]): void {
	const texts = outbound.filter((item) => item.kind === "text");
	if (texts.length <= 1) return;
	let index = 0;
	outbound.forEach((item, position) => {
		if (item.kind !== "text") return;
		index += 1;
		const suffix = ordinalSuffix(index, texts.length);
		outbound[position] = { kind: "text", html: item.html + suffix, plain: item.plain + suffix };
	});
}

