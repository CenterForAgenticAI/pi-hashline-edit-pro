Move a range of lines to another position, targeted by 4-character anchors from any served anchor│content row. Give `source_from` and `source_to` as bare anchors marking the first and last line to move in the source file, and `insert_after` as the bare anchor of the destination line after which the range goes. `insert_after` must sit outside the source range when both anchors share a file.

A cross-file `move` commits on its own when its source file also has batched edits in the message.
