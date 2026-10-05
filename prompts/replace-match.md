Replace part of a line (or a range of lines) without retyping the rest. `replace_from` and `replace_to` are bare anchors from served `anchor│content` rows marking the first and last line of the range; use the same anchor for one line. `old_string` is the text to find inside that range, and `new_string` replaces every occurrence of it.

A missing match is refused with the current rows, so the retry needs no read. The two boundary anchors must still match what was last shown; lines strictly inside the range are matched against the file as it is on disk.

A missing `old_string` aborts the whole batch unwritten.
