- `insert`: `lines` is one string with the exact text to insert; `""` inserts nothing and `"\n"` is one blank line.
- `insert`: a quoted payload goes in as one string — embedded line breaks are split for you, and a trailing line break is the last line's ending, not a blank line. Do not add a blank line to separate the inserted text from the line that follows.
- `insert`: after inserting a quoted payload, check the post-edit diff for an extra `+anchor│` blank row before the next line.

