/**
 * Inbound attachments: what gets fetched, where it lands, and what is refused.
 *
 * The refusal path matters as much as the happy one — Telegram caps bot
 * downloads at 20 MB, and discovering that after a partial download would leave
 * a truncated file in the user's working directory.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { attachmentOf, DOWNLOAD_DIRNAME, MAX_INBOUND_BYTES, receiveInboundFile } from "../../src/telegram/files.ts";
import type { TelegramApi, TelegramMessage } from "../../src/telegram/telegram/api.ts";

const roots: string[] = [];

/** A scratch working directory that is cleaned up after the suite. */
async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dsh-telegram-test-"));
	roots.push(dir);
	return dir;
}

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

/** A message carrying a document. */
function withDocument(name: string, size?: number): TelegramMessage {
	return {
		message_id: 1,
		date: 0,
		chat: { id: 7, type: "private" },
		document: { file_id: "f1", file_name: name, ...(size === undefined ? {} : { file_size: size }) },
	};
}

/** A Bot API stub that yields fixed bytes. */
function apiStub(bytes: Uint8Array, calls: { downloads: number }): TelegramApi {
	return {
		getFile: async () => ({ file_id: "f1", file_path: "documents/file.bin" }),
		downloadFile: async () => {
			calls.downloads += 1;
			return bytes;
		},
	} as unknown as TelegramApi;
}

test("attachmentOf prefers a document and otherwise takes the largest photo", () => {
	assert.equal(attachmentOf({ message_id: 1, date: 0, chat: { id: 1, type: "private" } }), undefined);
	assert.deepEqual(attachmentOf(withDocument("a.txt", 12)), { fileId: "f1", name: "a.txt", size: 12 });

	const photo = attachmentOf({
		message_id: 9,
		date: 0,
		chat: { id: 1, type: "private" },
		photo: [
			{ file_id: "small", width: 90, height: 90, file_size: 100 },
			{ file_id: "large", width: 1280, height: 1280, file_size: 900 },
		],
	});
	assert.equal(photo?.fileId, "large");
	assert.equal(photo?.name, "photo-9.jpg");
});

test("a stored attachment lands in downloads/ with a sanitized name", async () => {
	const cwd = await scratch();
	const calls = { downloads: 0 };
	const stored = await receiveInboundFile(
		apiStub(new TextEncoder().encode("hello"), calls),
		withDocument("../../etc/passwd"),
		cwd,
		() => undefined,
	);
	assert.ok(stored !== undefined && !("kind" in stored));
	assert.ok(stored.path.startsWith(join(cwd, DOWNLOAD_DIRNAME)), "must land inside the downloads directory");
	assert.ok(!stored.path.includes(".."), "path traversal must be neutralized");
	assert.equal(await readFile(stored.path, "utf8"), "hello");
	assert.equal(calls.downloads, 1);
});

test("an oversized attachment is refused without downloading anything", async () => {
	const cwd = await scratch();
	const calls = { downloads: 0 };
	const refused = await receiveInboundFile(
		apiStub(new Uint8Array(0), calls),
		withDocument("big.zip", MAX_INBOUND_BYTES + 1),
		cwd,
		() => undefined,
	);
	assert.ok(refused !== undefined && "kind" in refused);
	assert.equal(refused.kind, "too-large");
	assert.equal(calls.downloads, 0, "nothing should be fetched once the size is known to be over the limit");
	await assert.rejects(() => stat(join(cwd, DOWNLOAD_DIRNAME)));
});

test("bytes that exceed the ceiling after download are refused too", async () => {
	const cwd = await scratch();
	const calls = { downloads: 0 };
	const refused = await receiveInboundFile(
		apiStub(new Uint8Array(MAX_INBOUND_BYTES + 1), calls),
		withDocument("sneaky.bin"),
		cwd,
		() => undefined,
	);
	assert.ok(refused !== undefined && "kind" in refused);
	assert.equal(refused.kind, "too-large");
	assert.equal(calls.downloads, 1);
});

test("a download failure is reported to the user, not thrown", async () => {
	const cwd = await scratch();
	const failing = {
		getFile: async () => ({ file_id: "f1" }),
		downloadFile: async () => {
			throw new Error("boom");
		},
	} as unknown as TelegramApi;
	const failed = await receiveInboundFile(failing, withDocument("a.txt"), cwd, () => undefined);
	assert.ok(failed !== undefined && "kind" in failed);
	assert.equal(failed.kind, "failed");
});
