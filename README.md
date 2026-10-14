# keep-or-undo

A Claude Code mod that keeps a per-session log of the file changes Claude makes with `Edit`, `Write` and `NotebookEdit`, including those made by subagents. Each file can be **kept** or **undone**, like the "Keep / Undo" panel of IDE chat assistants.

- **Band above the prompt**, shown while changes are pending: `N files changed by Claude · +X −Y` with `[Review] [Keep all] [Undo all]`.
- **`/changes`** opens the pane: one row per file with `+a −r` and any badges (subagent, new file, absorbed external changes). Opening a row shows the diff of each change.
- **Keep** removes the file from the log and leaves it untouched.
- **Undo** restores the file to how it was before Claude's *first* pending change, or deletes it if Claude created it, then tells the model. If the file was changed by someone else after Claude's last change, it asks for confirmation and saves a backup first.
- **`/clear`** keeps everything.

Only changes made through the editing tools count, never `git diff`: changes already in the working tree stay out of the counts, and Undo returns to that prior state, not to HEAD.

## Install

At the prompt of a Claude Code session in the terminal:

```
/plugin install keep-or-undo --marketplace ivan-szz/keep-or-undo
```

Answer `y` to add the marketplace, then pick a scope (user scope is first). The mod is active right away, with no restart.

> [!IMPORTANT]
> The mod only sees changes made through Claude's editing tools (`Edit`, `Write`, `NotebookEdit`). Changes Claude makes from the shell (`sed`, `cat >`, heredocs, scripts) are not recorded and cannot be undone from `/changes`. It is strongly recommended to tell Claude to always use the editing tools, for example in your user-level `~/.claude/CLAUDE.md`:
>
> ```markdown
> - Always modify files with the Edit, Write or NotebookEdit tools, never through the shell
>   (`sed`, `awk`, `python`, heredocs, `cat >` or redirects), not even for small or mechanical changes.
> ```

## Usage

Options (`/config`, or `pluginConfigs` in settings):

| Option | Default | |
| --- | --- | --- |
| `retentionDays` | 14 | after how many days to delete data from old sessions |
| `autoOpenPane` | false | at the end of a turn, opens `/changes`, but only where the pane becomes a sidebar |

## Data

In `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/keep-or-undo/<sessionId>/`:

- `blobs/`: the contents before and after each change, the diffs, and the backups of confirmed undos
- `index.json`: a copy of the index

The index is also in the mod's store, under the key `sessions/<sessionId>`. Folders and keys older than `retentionDays` are deleted when a session starts.

## Development

```sh
claude --plugin-dir .   # loads the mod from this folder and reloads it on save
claude plugin validate .
claude plugin test .
tsc -p .   # after the first load, once the engine has written .claude-plugin/types/
```

## Known limitations

- Changes made with Bash are not recorded. If they touch a file with pending changes, though, they are absorbed: Undo reverts them too.
- Absorbed external changes are flagged with a badge but are not included in the `+/−` counts.
- A file over 4 MiB is recorded with counts only, and Undo is not available.
- When Undo deletes a file created by Claude, folders created along with it remain. A file created outside the session folder is not deleted.
