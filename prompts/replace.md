Replace a range of lines (or a single line) in a text file, targeted by 4-character anchors from any served anchor│content row. Give `remove_from` and `remove_to` as bare anchors marking the first and last line to remove, and `replacement_lines` as one string with the exact replacement text. `""` deletes the range, `"\n"` is one blank line, and a trailing line break sets the last line's ending instead of adding a blank line; escapes decode once — `\uXXXX` is the character, `\\uXXXX` the literal text. The text is written exactly as given, and nothing else in the file changes.
To change only part of a line without retyping the rest, use `replace_within` instead; it preserves every character the request does not name.

Same-file calls in one message batch: earlier calls reply `In batch N` and the last call shows the combined diff, with one undo for the whole batch.

Example: read served `Hasu│old` and `arvm│old2`. Call { "remove_from": "Hasu", "remove_to": "arvm", "replacement_lines": "new line 1\nnew line 2" }. The post-edit diff shows `-Hasu│old`, `-arvm│old2`, `+Qwer│new line 1`: the `-` rows are dead anchors now; the `+` and ` ` rows are live anchors for the next edit.
