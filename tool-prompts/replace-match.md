Replace part of a line (or a range of lines) without retyping the rest. `replace_from`/`replace_to` are bare anchors from served `anchor│content` rows marking the range's first and last line (the same anchor for one line), `old_string` is the text to find inside it, and `new_string` replaces every occurrence. `remove_from`/`remove_to` are accepted as aliases.

The two boundary anchors must still match what was last shown; lines strictly inside the range are matched against the file as it is on disk.
