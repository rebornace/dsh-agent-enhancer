/** Hard cap for export file size (aligned with design spec). */
export const WEB_CHAT_MAX_TEXT_BYTES = 5 * 1024 * 1024

/** Hard cap for structured turns after parse. */
export const WEB_CHAT_MAX_MESSAGES = 5000

/** Soft cap for conversations listed from one all-history export. */
export const WEB_CHAT_MAX_EXPORT_CONVERSATIONS = 200

/** Max conversations imported in one batch from the catalog picker. */
export const WEB_CHAT_MAX_BATCH_IMPORT = 50
