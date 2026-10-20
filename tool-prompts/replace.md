Replace a range of lines (or a single line) in a text file by anchor. Deleting every line empties the file, and the result names the empty-line anchor, so a follow-up `replace` can seed content without a `read`.

To change only part of a line without retyping the rest, use `replace_match` instead; it preserves every character the request does not name.
