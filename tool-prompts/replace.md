Replace a range of lines (or a single line) in a text file by anchor: `remove_from` and `remove_to` are the 4-character anchors of its first and last line, `text` is the exact replacement text, and `replace_from`/`replace_to` are accepted as aliases. Deleting every line empties the file, and the result names the empty-line anchor, so a follow-up `replace` can seed content without a `read`.

To change only part of a line without retyping the rest, use `replace_match` instead; it preserves every character the request does not name.
