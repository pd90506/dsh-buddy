/**
 * Content-addressed snapshots for skill mutations.
 *
 * Two mechanisms with deliberately opposite failure semantics live here:
 *
 * 1. {@link atomicSnapshot} — the **atomicity** snapshot. It copies a whole
 *    skill directory aside before that directory is modified or deleted, and a
 *    failure aborts the batch: *no snapshot, no atomicity*. The caller turns the
 *    returned `ok: false` into a refusal to write.
 * 2. {@link storeBlob} and the manifest primitives — the **audit** side. A blob
 *    is named by the lowercase hex sha256 of its own bytes, so identical content
 *    is stored once; a manifest is a sorted list of absolute paths and those
 *    digests. Nothing here is a gate — the ledger layer (see `ledger.ts`) catches
 *    every failure of this half so a telemetry problem can never block a write.
 *
 * Blobs land through a temp file plus `rename(2)` — the POSIX atomic replace —
 * so a reader never observes a half-written blob, and an already-present blob is
 * never rewritten. `snapshotPaths` deliberately does **not** store blobs: it
 * answers "what would change", while `captureBefore` in `ledger.ts` stores them.
 * @module dsh-buddy/skills/snapshot
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** One file in a snapshot manifest: its absolute path and the sha256 of its bytes. */
export interface SnapshotEntry {
	/** Absolute path of the captured file. */
	readonly path: string;
	/** Lowercase hex sha256 of the file's bytes. */
	readonly sha256: string;
}

/**
 * How a capture treats an entry it cannot read.
 *
 * `"throw"` is for a manifest that must be complete — a baseline rollback can
 * trust; `"skip"` is for a best-effort audit capture, where the rest of the
 * manifest is worth more than a hard failure.
 */
export type UnreadablePolicy = "throw" | "skip";

/** The only shape a blob file name may have, so a digest cannot traverse. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Store one blob under its content digest.
 *
 * The file is written to a temp name and `rename`d into place, which is atomic
 * on POSIX, so a crash leaves at most a stray temp file and never a partial
 * blob. Bytes already stored are not rewritten: the existing inode is returned
 * untouched, which is what makes deduplication observable.
 * @param snapshotsDir - the snapshot directory (`paths.skillSnapshots`).
 * @param bytes - the file's complete bytes.
 * @returns the lowercase hex sha256 the blob is named by.
 */
export async function storeBlob(snapshotsDir: string, bytes: Uint8Array): Promise<string> {
	const digest = sha256Hex(bytes);
	const target = join(snapshotsDir, digest);
	if (await isFile(target)) return digest;
	await mkdir(snapshotsDir, { recursive: true });
	// Re-check after creating the directory: another writer may have landed the
	// same content in the meantime, and rewriting it would be wasted I/O.
	if (await isFile(target)) return digest;
	const temp = join(snapshotsDir, `.tmp-${randomUUID()}`);
	try {
		await writeFile(temp, bytes);
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
	return digest;
}

/**
 * Read one blob back.
 *
 * Never throws: a missing blob, an unreadable blob and a name that is not a
 * digest at all all answer `undefined`, because every caller (the rollback
 * precheck above all) treats "cannot read it" as "it is not there".
 * @param snapshotsDir - the snapshot directory.
 * @param sha256 - the digest the blob is named by.
 * @returns the bytes, or `undefined` when the blob cannot be read.
 */
export async function readBlob(snapshotsDir: string, sha256: string): Promise<Uint8Array | undefined> {
	if (!SHA256_RE.test(sha256)) return undefined;
	try {
		return await readFile(join(snapshotsDir, sha256));
	} catch {
		return undefined;
	}
}

/**
 * Hash every file under one root, without storing anything.
 *
 * Paths are absolute and sorted, so two manifests of the same tree compare
 * equal and a rollback restores in a stable order. Symlinks are followed only
 * when they resolve to a regular file; a directory link is never followed,
 * because a link back up the tree would make the walk a cycle.
 * @param root - a file or a directory.
 * @returns one entry per regular file under the root.
 * @throws when the root does not exist, or a nested entry cannot be read.
 */
export async function snapshotPaths(root: string): Promise<SnapshotEntry[]> {
	const manifest: SnapshotEntry[] = [];
	for (const path of await listSnapshotFiles(root, "throw")) {
		manifest.push({ path, sha256: sha256Hex(await readFile(path)) });
	}
	return manifest;
}

/**
 * List the regular files a capture would read, sorted by absolute path.
 *
 * This is the walk primitive both {@link snapshotPaths} and the ledger's
 * `captureBefore` share, so "what a manifest contains" is decided in exactly one
 * place.
 * @param root - a file or a directory.
 * @param policy - `"throw"` for a complete capture, `"skip"` for a best-effort one.
 * @returns the absolute paths of the regular files, sorted.
 * @throws when the root is missing, or, under `"throw"`, when an entry cannot be read.
 */
export async function listSnapshotFiles(root: string, policy: UnreadablePolicy = "throw"): Promise<string[]> {
	const info = await stat(root);
	if (info.isFile()) return [root];
	if (!info.isDirectory()) return [];
	const found: string[] = [];
	await collectFiles(root, found, policy);
	found.sort();
	return found;
}

/**
 * Copy a skill directory aside before an atomic batch touches it.
 *
 * **Failure aborts the batch.** The returned error carries the literal phrase
 * *no snapshot, no atomicity* because that is the rule the caller is enforcing:
 * a batch that cannot be undone must not start.
 * @param dir - the skill directory to copy.
 * @param dest - where the copy goes; created, including parents.
 * @returns `{ ok: true }`, or the refusal message.
 */
export async function atomicSnapshot(dir: string, dest: string): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await cp(dir, dest, { recursive: true });
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `Could not snapshot '${basename(dir)}' for atomic batch: no snapshot, no atomicity — ${messageOf(error)}`,
		};
	}
}

/**
 * Walk one directory into `found`.
 * @param dir - the directory to read.
 * @param found - accumulator, appended in readdir order (the caller sorts).
 * @param policy - whether an unreadable entry throws or is skipped.
 */
async function collectFiles(dir: string, found: string[], policy: UnreadablePolicy): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(path, found, policy);
			continue;
		}
		if (entry.isFile()) {
			found.push(path);
			continue;
		}
		if (!entry.isSymbolicLink()) {
			// FIFOs, sockets and devices are not skill content, and reading one
			// can block the whole capture.
			unreadable(path, new Error("not a regular file"), policy);
			continue;
		}
		let target: Awaited<ReturnType<typeof stat>>;
		try {
			target = await stat(path);
		} catch (error) {
			unreadable(path, error, policy);
			continue;
		}
		if (target.isFile()) {
			found.push(path);
			continue;
		}
		unreadable(path, new Error(`symbolic link to a ${target.isDirectory() ? "directory" : "special file"}`), policy);
	}
}

/**
 * Apply the capture policy to one entry that cannot be read.
 * @param path - the entry's path, for the message.
 * @param error - why it could not be read.
 * @param policy - `"throw"` rethrows, `"skip"` logs and drops the entry.
 */
function unreadable(path: string, error: unknown, policy: UnreadablePolicy): void {
	if (policy === "throw") throw error;
	console.error("skill_snapshot: skipped '%s' (%s)", path, messageOf(error));
}

/**
 * Whether a blob file already exists.
 * @param path - the blob's absolute path.
 * @returns `true` when a regular file is there.
 */
async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * @param bytes - the content to hash.
 * @returns its lowercase hex sha256.
 */
function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
