Insert text after or before one existing line in a text file, addressed by a bare anchor from any served anchor│content row. The anchor line is preserved: `lines` go after it with `direction: "after"` or before it with `direction: "before"`. `lines` is one string holding the exact text to insert; escapes decode once — `\uXXXX` is the character, `\\uXXXX` the literal text.

Same-file calls in one message batch: earlier calls reply `In batch N` and the last call shows the combined diff, with one undo for the whole batch.
