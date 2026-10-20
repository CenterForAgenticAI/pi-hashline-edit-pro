Replace part of a line — or the same fragment on several lines of a range — without retyping the rest. `match` only needs to be unique inside the anchored range, not file-wide, so send only the fragment that changes and narrow `replace_from`/`replace_to` when only one occurrence should change. For a whole-line rewrite, use `replace` with the same anchors.

The two boundary anchors must still match what was last shown; lines strictly inside the range are searched as they are on disk.
