/**
 * The one literal both halves must agree on: the credentials key holding the bot
 * token.
 *
 * It lives in its own module, free of imports, because the browser bundle has to
 * include it too — the tab writes the token through the platform's
 * `credentials.*` namespace while the host reads it through `credentialRef`, and
 * the two spellings have to be the same string. Written twice, a rename on one
 * side would not fail any test; it would silently leave the bot with no token and
 * the tab reporting one.
 * @module dsh-buddy/telegram/credential-key
 */

/** Credentials key for the Telegram bot token; a POSIX identifier, as required. */
export const TELEGRAM_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";
