# Cline multi-agent orchestrator setup

This package connects Cline CLI to two subscription-backed providers:

- **Plan and review:** `openai-codex` (ChatGPT subscription)
- **Implementation:** `claude-code` (Claude Code subscription)

It loops through Plan -> Act -> build -> review -> fixes, then creates a **local Git checkpoint** for accepted milestones. It never pushes commits to GitHub. It stops when a provider fails, a review is blocked, or retries are exhausted.

## 1. Copy the two files

Copy `orchestrate.py` and `GAME_PLAN.md` into the **root folder of the existing Phaser project** alongside `package.json`. You can edit `GAME_PLAN.md` to specify your complete vision. Do not copy over any Phaser files.

## 2. Open VS Code terminal in the project folder

Run:

```powershell
npm install -g cline
cline --version
claude --version
```

The Cline VS Code extension and the terminal CLI do not always share a login session. If needed, run:

```powershell
cline auth openai-codex
claude
```

Sign in to both accounts in the prompts. Exit the Claude interactive session when complete. Check that Cline's Claude Code provider works too:

```powershell
cline --provider openai-codex --plan "Reply with READY"
cline --provider claude-code --plan "Reply with READY"
```

If the second command fails, verify the Claude CLI login, CLI availability on PATH, and the current Cline version.

## 3. Save your current code in Git first

The orchestrator refuses to start if the working tree isn't clean. In the Phaser project:

```powershell
git status
```

If this folder isn't a Git repository, initialize it:

```powershell
git init
```

Make sure `.gitignore` excludes `node_modules/`, `dist/`, `.env`, `.env.*`, and local secrets. Then make a local backup commit:

```powershell
git add .
git commit -m "Backup before AI orchestrator"
```

The orchestrator stores its logs under `.agent-loop/` and excludes that folder from Git with a local `.git/info/exclude` entry. Never commit secrets. The script checks suspicious filenames but is not a full secret scanner.

## 4. Check prerequisites

```powershell
python orchestrate.py --check
```

## 5. Start the loop

Start with one small milestone:

```powershell
python orchestrate.py --milestones 1 --fixes 2
```

When this works, let it process three milestones:

```powershell
python orchestrate.py --milestones 3 --fixes 2
```

It asks for `YES` once before unattended edits. You can add `--yes` to skip that confirmation. Cline's unattended execution includes tool approval, so use it only inside a project you trust, preferably on a separate branch. Check any generated code and run the game yourself before relying on its behavior.

## 6. Follow progress

- `.agent-loop/m1-task.md`: Codex's first task for Claude.
- `.agent-loop/m1-attempt1-act.jsonl`: Claude's implementation logs.
- `.agent-loop/m1-attempt1-review.md`: Codex's code review.
- `.agent-loop/m1-attempt1-build.txt`: build output.
- `.agent-loop/review.diff`: latest Git diff inspected by Codex.
- `DEVELOPMENT_STATUS.md`: accepted milestones and reviewer notes.
- `git log --oneline -5`: local Git checkpoints.

If it stops on an error, inspect the log and `git status`. Do not delete uncommitted work. Fix the blocker and commit/review the code before running another clean loop.

## Notes

- Cline CLI subscriptions have their own rate/usage limits.
- The script verifies `npm run build` and asks the reviewer to inspect diffs. It cannot verify gameplay visually. Perform a manual playtest after each batch.
- There is no unattended deletion/rollback logic. This is deliberate. The script stops and leaves code for inspection rather than throwing away work.
- Claude Code may enforce additional permission rules from your local Claude configuration.
- This is a custom orchestration script, not an automatic feature of the VS Code extension.

Official CLI documentation: https://docs.cline.bot/cli/cli-reference
