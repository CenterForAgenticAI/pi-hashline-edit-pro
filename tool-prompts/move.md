Relocate a range of lines to another anchor. Within one file the destination must sit outside the source range; moving a range onto itself reports `No changes made` and leaves the anchors alone. Rows between the source and the destination keep their content but may be re-anchored, so read that span again if you plan to edit it.

A cross-file move commits on its own when its source file also has batched edits in the message.
