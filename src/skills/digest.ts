/**
 * The cheap-model review digest: a synthesized prefix plus the verbatim tail.
 *
 * When the automatic review is routed to a different (cheaper) model, a
 * `fork` would be illegal — the fork seed contract is "a contiguous completed
 * turn prefix of the parent log", and a synthesized digest is not one — so the
 * review is a `spawn` and this module is what carries the conversation into it.
 * The reference implementation's shape is deliberate and copied number for
 * number (`$H:agent/background_review.py:264-294`, spec §7.1):
 *
 * - **Keep the last {@link TAIL} messages verbatim**, growing that run forward
 *   while it would start on a `tool` result. A digest that begins with a tool
 *   result hands the model a payload whose request it can no longer see; the
 *   loop trades a few more kept turns for a readable prefix.
 * - **Collapse every earlier turn into exactly one synthetic `user` message**,
 *   never a separate message per turn, so role alternation downstream is not
 *   disturbed.
 * - **`tool` results are dropped entirely**, `user` text is truncated to
 *   {@link USER_CHARS}, assistant text to {@link ASSISTANT_CHARS}, assistant
 *   tool calls become a name list, and newlines collapse to spaces because one
 *   digest line must survive being one line.
 *
 * Two limits are the point of the module — the digest bounds the aux model's
 * cold-write cost — so the constants are exported for a test to assert and are
 * not tunable here.
 *
 * The module is **pure and total**: no filesystem, no cordis context, no clock,
 * no randomness, and no input (an empty array included) can make it throw. It
 * never touches a live harness object; {@link DigestMessage} is a small owned
 * shape the caller builds from the leaf fields of whatever it read.
 * @module dsh-buddy/skills/digest
 */

/** One turn as the digest sees it — the review's own shape, never a harness object. */
export interface DigestMessage {
	/** Who spoke. A `tool` turn is a tool result and is only ever dropped. */
	readonly role: "user" | "assistant" | "tool";
	/** The turn's plain text, already extracted from any content blocks. */
	readonly text: string;
	/** The names of the tools an assistant turn called, when it called any. */
	readonly toolNames?: readonly string[];
}

/** How many trailing messages survive verbatim before the digest starts. */
export const TAIL = 24;

/** How much of an earlier user turn the digest keeps. */
export const USER_CHARS = 300;

/** How much of an earlier assistant turn the digest keeps. */
export const ASSISTANT_CHARS = 200;

/**
 * The digest header, copied from the reference implementation. It is the first
 * thing in the synthetic message, so a reader (and the test that guards the
 * shape) can recognize a digest by `[Earlier conversation digest`.
 */
const DIGEST_PREFIX =
	"[Earlier conversation digest — older turns summarised to bound the review's cold-write cost " +
	"on the routed aux model. Recent turns follow verbatim below.]\n";

/** One digest line: trim, then collapse newlines, so the line cannot wrap. */
function flatten(text: string): string {
	return text.replace(/\n/g, " ").trim();
}

/**
 * Compact a conversation for a review running on a different model.
 *
 * @param messages The turns, oldest first. Read only; the result never shares
 *   the array with the input (the input is `readonly`, and a caller that wanted
 *   the array back already has it).
 * @returns Either the input's contents unchanged, when the whole history fits
 *   in the tail, or one synthetic `user` digest followed by the kept tail.
 */
export function digestHistory(messages: readonly DigestMessage[]): DigestMessage[] {
	let tail = TAIL;
	while (messages.length > tail && messages[messages.length - tail]!.role === "tool") {
		tail += 1;
	}
	if (messages.length <= tail) return messages.slice();

	const earlier = messages.slice(0, messages.length - tail);
	const lines: string[] = [];
	for (const message of earlier) {
		if (message.role === "tool") continue;
		const text = flatten(message.text);
		if (message.role === "user") {
			// The reference skips an empty turn rather than emitting a bare label.
			if (text !== "") lines.push(`USER: ${text.slice(0, USER_CHARS)}`);
			continue;
		}
		const names = message.toolNames;
		if (names !== undefined && names.length > 0) lines.push(`ASSISTANT[tools: ${names.join(", ")}]`);
		if (text !== "") lines.push(`ASSISTANT: ${text.slice(0, ASSISTANT_CHARS)}`);
	}

	return [{ role: "user", text: DIGEST_PREFIX + lines.join("\n") }, ...messages.slice(messages.length - tail)];
}
