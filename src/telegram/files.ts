/**
 * Inbound files.
 *
 * Two constraints drive this module. Telegram's Bot API caps a bot's downloads at
 * 20 MB on the public API, and a file's download URL expires about an hour after
 * `getFile` — so an attachment has to be fetched when the message arrives, not
 * when the agent eventually looks at it. Files land in a `downloads/`
 * subdirectory of the session's working directory rather than its root: they are
 * this chat's material, and keeping them in one place keeps them out of the way
 * of the agent's own files, while staying somewhere the user can find them.
 * @module dsh-buddy/telegram/files
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TelegramApi, TelegramMessage } from "./telegram/api.ts";

/** Public Bot API download ceiling. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

/** Subdirectory of the working directory that receives attachments. */
export const DOWNLOAD_DIRNAME = "downloads";

/** A successfully stored attachment. */
export interface StoredFile {
	/** Absolute path, as handed to the agent. */
	readonly path: string;
	/** Original name, when Telegram reported one. */
	readonly name: string;
	/** Byte length. */
	readonly size: number;
}

/** Why an attachment was not stored. */
export interface FileRefusal {
	/** `too-large` is expected and user-facing; `failed` is an error. */
	readonly kind: "too-large" | "failed";
	/** Message text to show the user. */
	readonly message: string;
}

/** The attachment a message carries, if any. */
export interface InboundAttachment {
	readonly fileId: string;
	readonly name: string;
	readonly size: number | undefined;
}

/**
 * Pick the attachment to fetch: a document, else the largest photo size.
 * @param message - an incoming Telegram message.
 * @returns the attachment, or undefined for a text-only message.
 */
export function attachmentOf(message: TelegramMessage): InboundAttachment | undefined {
	if (message.document !== undefined) {
		return {
			fileId: message.document.file_id,
			name: message.document.file_name ?? "document",
			size: message.document.file_size,
		};
	}
	const photos = message.photo;
	if (photos !== undefined && photos.length > 0) {
		// Telegram orders sizes ascending, so the last entry is the largest.
		const largest = photos[photos.length - 1];
		if (largest === undefined) return undefined;
		return { fileId: largest.file_id, name: `photo-${String(message.message_id)}.jpg`, size: largest.file_size };
	}
	return undefined;
}

/** The one refusal message for an attachment over the download ceiling. */
function tooLarge(): FileRefusal {
	const limitMb = Math.floor(MAX_INBOUND_BYTES / (1024 * 1024));
	return { kind: "too-large", message: `This file is over ${String(limitMb)} MB; Telegram does not let bots download it.` };
}

/** Reduce a Telegram-supplied name to something safe to join onto a directory. */
function safeName(raw: string, fallback: string): string {
	const base = raw.split(/[/\\]/).pop() ?? fallback;
	const cleaned = base.replaceAll(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
	return cleaned === "" ? fallback : cleaned.slice(0, 120);
}

/**
 * Download an inbound attachment into the session's working directory.
 *
 * @param api - the bound Bot API client.
 * @param message - the incoming message.
 * @param cwd - the session's working directory (absolute).
 * @param log - diagnostic sink.
 * @returns the stored file, a refusal, or undefined when there is no attachment.
 */
export async function receiveInboundFile(
	api: TelegramApi,
	message: TelegramMessage,
	cwd: string,
	log: (line: string) => void,
): Promise<StoredFile | FileRefusal | undefined> {
	const attachment = attachmentOf(message);
	if (attachment === undefined) return undefined;
	if (attachment.size !== undefined && attachment.size > MAX_INBOUND_BYTES) return tooLarge();
	const directory = join(cwd, DOWNLOAD_DIRNAME);
	try {
		const file = await api.getFile(attachment.fileId);
		if (file.file_path === undefined) {
			return { kind: "failed", message: "Telegram returned no file path, so the file cannot be downloaded." };
		}
		const bytes = await api.downloadFile(file.file_path);
		if (bytes.byteLength > MAX_INBOUND_BYTES) return tooLarge();
		await mkdir(directory, { recursive: true });
		// Timestamped so a second file with the same name cannot overwrite the first.
		const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
		const name = `${stamp}-${safeName(attachment.name, "file")}`;
		const path = join(directory, name);
		await writeFile(path, bytes);
		return { path, name, size: bytes.byteLength };
	} catch (error) {
		log(`inbound file failed: ${(error as Error).message}`);
		return { kind: "failed", message: "The file download failed. Please send it again." };
	}
}
