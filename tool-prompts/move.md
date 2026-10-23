Relocate a range of lines to another anchor. Within one file the destination must sit outside the source range. Rows between the source and the destination keep their content but may be re-anchored, so read that span again if you plan to edit it.

A cross-file move whose source file also gets other edits in the same message runs outside any batch: same-message edits to its destination file then either abort or make the move fail, so send that move in a separate message.
