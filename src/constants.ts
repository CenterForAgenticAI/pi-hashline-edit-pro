export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_RANGE_STALE_LINES = 100;
export const MAX_OVERSIZED_WARNING_LINES = 100;

export const MAX_HASH_SOURCE_BYTES = 500;
export const MAX_GREP_LINE_BYTES = 500;

export const MAX_DIFF_INPUT_BYTES = 1024 * 1024;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 9;
export const NEW_CONTENT_NOT_ARRAY_MSG =
  `[E_BAD_SHAPE] "text" must be an array of strings, one per line (use [] to delete).`;

export const NEW_CONTENT_NOT_STRING_MSG =
  `[E_BAD_SHAPE] "text" must be a string holding the exact text to write. Use "" to delete the range and "\\n" for one blank line; line breaks inside the string separate lines.`;

export const TEXT_NOT_STRING_MSG =
  `[E_BAD_SHAPE] "text" must be a string holding the exact text to insert. Use "\\n" for one blank line; line breaks inside the string separate lines.`;

export const NUL_CONTENT_MSG =
  `[E_BAD_SHAPE] Content contains a NUL byte (U+0000); a text file cannot contain NUL, and writing it would break further reads and edits. Remove the NUL byte and retry.`;

export const ANCHOR_POOL_EXHAUSTED_PREFIX =
  "[E_FILE_TOO_LARGE] The session's anchor pool is exhausted";

export const ANCHOR_RECLAIM_WARNING_CODE = "[W_ANCHOR_RECLAIMED]";
export const MAX_RECLAIMED_PATHS_REPORTED = 10;

export const AUTO_READ_ALL_CUSTOM_TYPE = "hashline-auto-read-all";
export const AUTO_READ_ALL_MAX_FILES = 500;
export const AUTO_READ_ALL_MAX_FILE_BYTES = 200_000;
export const AUTO_READ_ALL_MIN_BUDGET_BYTES = 200_000;
export const AUTO_READ_ALL_MAX_BUDGET_BYTES = 2_000_000;
