/**
 * The browser half's call into this plugin's own `buddyPersona/*` endpoints.
 *
 * `rpc.call` resolves with the API gateway's `{ ok, value | error }` envelope,
 * which is *not* the payload: an endpoint that threw still resolves, so code that
 * reads `result.value` directly treats a failure as a successful empty answer and
 * silently blanks whatever it was bound to. Unwrapping it once, here, is what
 * keeps the rest of the UI dealing in payloads only.
 *
 * This is deliberately a plain `.ts` module rather than part of the `.tsx` tab:
 * no test in this plan may import a `.tsx` file — Node's type stripping does not
 * handle JSX — and this is the one piece of browser-half logic whose failure mode
 * is invisible in the markup, so it has to be drivable from a test directly.
 * @module dsh-buddy/client/call
 */

/** The slice of the connection service's RPC client this plugin uses. */
export interface RpcClient {
	/**
	 * Send one request.
	 * @param route - the gateway route; always `/api` for typert endpoints.
	 * @param endpoint - `namespace/method`.
	 * @param payload - the request body.
	 * @returns the gateway envelope.
	 */
	call(route: string, endpoint: string, payload: unknown): Promise<unknown>;
}

/** An unwrapped endpoint call: resolves the payload or throws. */
export type Call = (endpoint: string, args: unknown) => Promise<unknown>;

/** The gateway route every typert endpoint is served on. */
const API_ROUTE = "/api";

/** The envelope as far as this unwrap reads it. */
interface Envelope {
	readonly ok?: unknown;
	readonly value?: unknown;
	readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/**
 * Bind an unwrapped caller to an RPC client.
 * @param rpc - the connection service's RPC client.
 * @returns a caller that resolves payloads and throws on anything else.
 */
export function createCall(rpc: RpcClient): Call {
	return async function call(endpoint: string, args: unknown): Promise<unknown> {
		const result = (await rpc.call(API_ROUTE, endpoint, { args })) as Envelope | undefined | null;
		// Anything that is not an explicit success is a failure, including a
		// missing envelope: resolving `undefined` as a payload here is exactly how
		// a dead endpoint ends up looking like an empty persona.
		if (result?.ok !== true) {
			const error = result?.error;
			throw new Error(
				typeof error?.message === "string"
					? `${endpoint} failed: ${String(error.code)}: ${error.message}`
					: `${endpoint} failed`,
			);
		}
		return result.value;
	};
}
