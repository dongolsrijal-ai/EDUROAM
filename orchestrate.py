#!/usr/bin/env python3
"""Small, checkpointed Cline CLI Plan -> Act -> Review runner.

Requires an existing Git repo, npm Phaser project, and authenticated Cline CLI.
Uses OpenAI Codex for planning/review and Claude Code for implementation.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime

PLAN_PROVIDER = "openai-codex"
ACT_PROVIDER = "claude-code"
LOG_DIR = ".agent-loop"
SECRET_PATH = re.compile(r"(^|/)(\.env($|\.)|.*\.(?:pem|key|p12|pfx)$|.*(?:secret|credential|private.?key).*)", re.I)


def executable_command(command: list[str]) -> list[str]:
    """Resolve Windows npm-installed .cmd launchers before subprocess starts.

    PowerShell finds commands using PATHEXT, but Windows CreateProcess when
    called from Python doesn't always resolve bare `npm` / `cline` to .cmd.
    Providing the full path to npm.cmd/cline.cmd avoids WinError 2.
    """
    if os.name == "nt" and command:
        resolved = shutil.which(command[0])
        if resolved:
            return [resolved, *command[1:]]
    return command


def call(command: list[str], cwd: Path, *, timeout: int = 180, checked: bool = True) -> subprocess.CompletedProcess:
    command = executable_command(command)
    outcome = subprocess.run(command, cwd=str(cwd), text=True, encoding="utf-8", errors="replace",
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if checked and outcome.returncode:
        raise RuntimeError(f"Command failed ({outcome.returncode}): {' '.join(command)}\n{outcome.stdout[-2000:]}")
    return outcome


def git(project: Path, *args: str, checked: bool = True) -> str:
    return call(["git", *args], project, checked=checked).stdout.strip()


def add_local_log_exclusion(project: Path):
    location = git(project, "rev-parse", "--git-path", "info/exclude")
    exclude = Path(location)
    if not exclude.is_absolute():
        exclude = (project / exclude).resolve()
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    if f"{LOG_DIR}/" not in existing.splitlines():
        exclude.write_text(existing.rstrip("\n") + f"\n{LOG_DIR}/\n", encoding="utf-8")


def require_ready(project: Path):
    if not shutil.which("cline"):
        raise RuntimeError("Cline CLI not found. Run: npm install -g cline")
    if not shutil.which("git"):
        raise RuntimeError("Git not found. Install Git first.")
    if not shutil.which("npm"):
        raise RuntimeError("npm not found. Install Node.js first.")
    if not (project / "package.json").is_file():
        raise RuntimeError("No package.json here. Use --project to select your existing Phaser project.")
    if not (project / "GAME_PLAN.md").is_file():
        raise RuntimeError("GAME_PLAN.md missing. Copy the supplied plan into your project root.")
    if git(project, "rev-parse", "--is-inside-work-tree") != "true":
        raise RuntimeError("Run inside a Git repository.")
    add_local_log_exclusion(project)
    if git(project, "status", "--porcelain"):
        raise RuntimeError("Working tree has uncommitted changes. Commit your current project first so the agent has a safe checkpoint.\nUse: git add . && git commit -m 'Backup before agent loop'")
    if git(project, "diff", "--cached", "--name-only"):
        raise RuntimeError("Staged files exist. Commit them first.")
    try:
        call(["cline", "--version"], project, timeout=30)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Windows failed to launch Cline. Check `where.exe cline` and `cline --version`; "
            "npm-installed CLI commands normally use cline.cmd."
        ) from exc


def cline_run(project: Path, provider: str, prompt: str, log_file: Path, *, plan: bool, timeout_seconds: int) -> str:
    """Run one Cline task without writing into a possibly closed stdin pipe.

    A prompt file provides input through stdin, and a short positional prompt
    keeps headless Cline invocation unambiguous. This avoids broken pipes when
    Windows .cmd launchers exit before Python finishes writing the prompt.
    """
    prompt_file = log_file.with_suffix(".prompt.txt")
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    prompt_file.write_text(prompt, encoding="utf-8")
    relative_prompt_path = prompt_file.relative_to(project).as_posix()
    instruction = (
        f"Follow the full instructions in {relative_prompt_path} (also supplied "
        "on standard input). Return the requested final output format."
    )
    command = ["cline", "--json", "--provider", provider, "--cwd", str(project),
               "--timeout", str(timeout_seconds)]
    if plan:
        command.append("--plan")
    else:
        command.extend(["--auto-approve", "true"])
    command.append(instruction)
    print(f"\n[{provider} | {'PLAN / REVIEW' if plan else 'ACT'}]", flush=True)
    final = None
    finish_reason = None
    # Do not write to process.stdin. If Cline quits early due to missing login,
    # Windows will not raise BrokenPipeError; we can read the CLI error instead.
    with prompt_file.open("rb") as prompt_stream, log_file.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(executable_command(command), cwd=str(project), stdin=prompt_stream,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace", bufsize=1)
        assert process.stdout
        for line in process.stdout:
            log.write(line)
            log.flush()
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = message.get("type")
            if kind == "run_result":
                final = message.get("text")
                finish_reason = message.get("finishReason")
            elif kind == "agent_event":
                event = message.get("event") or {}
                if event.get("type") == "done" and not final:
                    final = event.get("text")
                elif event.get("type") == "iteration_end":
                    print("  Agent step completed", flush=True)
                elif event.get("type") == "error":
                    print("  Agent error:", event.get("message", "Unknown"), flush=True)
            elif kind == "error":
                print("  CLI error:", message.get("message", "Unknown"), flush=True)
        try:
            rc = process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError(f"Cline did not exit cleanly. Inspect {log_file}")
    if rc or not final or finish_reason == "aborted":
        output = log_file.read_text(encoding="utf-8", errors="replace")[-3000:]
        raise RuntimeError(
            f"Cline run failed for {provider} (exit={rc}, finish={finish_reason}).\n"
            f"CLI output tail:\n{output or '(no output)'}\n"
            f"Full log: {log_file}\n"
            "If the error mentions authentication, run `cline auth openai-codex` "
            "and verify the Claude Code CLI login separately."
        )
    print(f"  Finished. Log: {log_file}", flush=True)
    return str(final).strip()


def task_from(text: str) -> str:
    found = re.search(r"TASK_BEGIN\s*\n(.*?)\n\s*TASK_END", text, flags=re.S | re.I)
    if not found or not found.group(1).strip():
        raise RuntimeError("Planner did not return TASK_BEGIN / TASK_END. See its log and retry.")
    return found.group(1).strip()


def verdict_from(text: str) -> str:
    match = re.search(r"(?im)^\s*(?:\*\*)?VERDICT\s*:\s*(PASS|FIX|BLOCK)\b", text)
    if not match:
        raise RuntimeError("Reviewer did not give VERDICT: PASS, FIX, or BLOCK. See its log.")
    return match.group(1).upper()


def safe_stage(project: Path):
    paths = git(project, "ls-files", "--others", "--exclude-standard").splitlines()
    paths += git(project, "diff", "--name-only").splitlines()
    flagged = [p for p in paths if SECRET_PATH.search(p.replace("\\", "/"))]
    if flagged:
        raise RuntimeError("Potentially sensitive file changes detected. Review before staging: " + ", ".join(flagged))
    git(project, "add", "-A")
    staged = git(project, "diff", "--cached", "--name-only").splitlines()
    flagged = [p for p in staged if SECRET_PATH.search(p.replace("\\", "/"))]
    if flagged:
        git(project, "reset")  # Unstage only; do not delete code.
        raise RuntimeError("Potentially sensitive staged files: " + ", ".join(flagged))
    return staged


def read_status(project: Path) -> str:
    status = project / "DEVELOPMENT_STATUS.md"
    return status.read_text(encoding="utf-8") if status.exists() else "No milestones completed yet."


def plan_prompt(project: Path, milestone: int) -> str:
    return f"""You are the senior architect for an existing Phaser + JavaScript + Vite educational roguelite.
You are planning work for Claude Code, which will edit the same local Git repository.
Read relevant source files to ground your plan. Do not edit files, install packages, or run destructive commands.

MASTER SPECIFICATION:
{(project / 'GAME_PLAN.md').read_text(encoding='utf-8')}

COMPLETED MILESTONES:
{read_status(project)}

Select ONLY the next smallest useful, verifiable milestone, number {milestone}.
Prefer gameplay-critical tasks over cosmetic upgrades. Include affected files (if known),
clear acceptance criteria, and a test plan. Ask Claude to preserve existing game features.
Choose a small implementation that is realistic to complete in one coding iteration.

OUTPUT FORMAT EXACTLY:
TASK_BEGIN
<detailed, bounded implementation instructions and acceptance criteria>
TASK_END
No code changes. No other text outside the markers.
"""


def action_prompt(project: Path, task: str, feedback: str | None) -> str:
    return f"""You are the implementation engineer for an existing Phaser + JavaScript + Vite game.
Work in the current repository; don't create a new project. Implement only the assigned task.
Preserve current game mechanics and saved data. Never run destructive Git commands, create commits,
modify GAME_PLAN.md or DEVELOPMENT_STATUS.md, push code, or read/write secrets.
You may edit code and run appropriate local validation. Avoid unrelated refactors.

ASSIGNED TASK:
{task}

{'REVIEWER CORRECTIONS TO ADDRESS:\n' + feedback if feedback else ''}

After implementing, run npm run build if practical. Report files changed, tests run,
remaining limitations, and any blocker. Do not claim a test passed unless it ran.
"""


def tests_and_diff(project: Path, log_dir: Path, round_label: str) -> tuple[bool, str, list[str]]:
    try:
        test = call(["npm", "run", "build"], project, timeout=240, checked=False)
        build_ok = test.returncode == 0
        report = f"npm run build exit={test.returncode}\n{test.stdout[-9000:]}"
    except Exception as exc:
        build_ok = False
        report = f"npm run build failed to execute: {exc}"
    (log_dir / f"{round_label}-build.txt").write_text(report, encoding="utf-8")
    changed = safe_stage(project)
    stat = git(project, "diff", "--cached", "--stat", "HEAD")
    diff = git(project, "diff", "--cached", "--no-ext-diff", "HEAD")
    (log_dir / "review.diff").write_text(diff, encoding="utf-8")
    return build_ok, report, changed


def review_prompt(project: Path, task: str, action_result: str, build_ok: bool, build_report: str, changed: list[str]) -> str:
    diff_path = project / LOG_DIR / "review.diff"
    return f"""You are an independent code reviewer of a Phaser JavaScript Vite game.
Work in PLAN mode. Do not write files or execute destructive operations.

ASSIGNED TASK AND ACCEPTANCE CRITERIA:
{task}

IMPLEMENTER SUMMARY (unverified claims):
{action_result[-12000:]}

BUILD RESULT: {'PASS' if build_ok else 'FAIL'}
{build_report[-5000:]}

STAGED FILES:
{chr(10).join(changed) if changed else '(none)'}

Review the actual staged Git diff using git diff --cached HEAD and relevant source files.
A full diff copy is available at {diff_path} if needed. Do not rely only on Claude's summary.
Check behavior, controls, persistence, tests, regression risks, and acceptance criteria.
If anything essential is unimplemented, return FIX. If build fails, return FIX.
If blocked by missing dependencies, credentials, unclear requirements, or access, return BLOCK.
Never claim manual gameplay was tested if you did not run it.

Start your answer with ONE line in EXACT format:
VERDICT: PASS
or
VERDICT: FIX
or
VERDICT: BLOCK
Then give a concise, actionable explanation. For FIX include precise corrections.
"""


def commit_milestone(project: Path, milestone: int, task: str, review: str):
    status = project / "DEVELOPMENT_STATUS.md"
    title = task.splitlines()[0][:100]
    with status.open("a", encoding="utf-8") as f:
        f.write(f"\n## Milestone {milestone} accepted ({datetime.now().strftime('%Y-%m-%d %H:%M')})\n")
        f.write(f"Task: {title}\n\n")
        f.write("Reviewer: " + review[:1500].replace("\n", " ") + "\n")
    safe_stage(project)
    check = git(project, "diff", "--cached", "--check", checked=False)
    if check:
        raise RuntimeError("git diff --cached --check detected whitespace issues:\n" + check)
    git(project, "commit", "-m", f"AI checkpoint {milestone}: {title[:55]}")


def main():
    p = argparse.ArgumentParser(description="Cline orchestration: Codex plans/reviews, Claude Code acts.")
    p.add_argument("--project", default=".", help="Path to your existing Phaser project")
    p.add_argument("--milestones", type=int, default=2, help="Number of accepted milestones to attempt (default: 2)")
    p.add_argument("--fixes", type=int, default=2, help="Correction attempts per milestone (default: 2)")
    p.add_argument("--timeout", type=int, default=900, help="Seconds allowed per Cline run (default: 900)")
    p.add_argument("--yes", action="store_true", help="Accept unattended code-edit permission without interactive confirmation")
    p.add_argument("--check", action="store_true", help="Validate local prerequisites without invoking models")
    args = p.parse_args()
    if args.milestones < 1 or args.milestones > 10 or args.fixes < 0 or args.fixes > 5:
        p.error("Use 1-10 milestones and 0-5 correction attempts.")
    project = Path(args.project).expanduser().resolve()
    require_ready(project)
    print(f"Project: {project}\nCline: {call(['cline','--version'], project).stdout.strip()}")
    if os.name == "nt":
        print("Windows commands:")
        for name in ("cline", "npm", "git"):
            print(f"  {name}: {shutil.which(name) or 'not found'}")
    print("Plan/review provider: openai-codex; act provider: claude-code")
    if args.check:
        print("Preflight OK. Authentication and actual model responses not tested.")
        return
    if not args.yes:
        print("WARNING: Claude Code receives unattended code-edit/tool permissions.")
        print("This script makes local Git commits after passing reviews. It never pushes to a remote.")
        confirm = input("Run within this trusted repository? Type YES: ")
        if confirm != "YES":
            print("Cancelled.")
            return
    logs = project / LOG_DIR
    logs.mkdir(parents=True, exist_ok=True)
    for milestone in range(1, args.milestones + 1):
        print(f"\n========== MILESTONE {milestone}/{args.milestones} ==========", flush=True)
        current_head = git(project, "rev-parse", "HEAD")
        plan = cline_run(project, PLAN_PROVIDER, plan_prompt(project, milestone),
                         logs / f"m{milestone}-plan.jsonl", plan=True, timeout_seconds=args.timeout)
        if git(project, "rev-parse", "HEAD") != current_head or git(project, "status", "--porcelain"):
            raise RuntimeError("Planner unexpectedly modified tracked files. Stop and inspect Git changes.")
        task = task_from(plan)
        (logs / f"m{milestone}-task.md").write_text(task, encoding="utf-8")
        print("\nNEXT TASK:\n" + task[:1400], flush=True)
        feedback = None
        for attempt in range(args.fixes + 1):
            label = f"m{milestone}-attempt{attempt + 1}"
            result = cline_run(project, ACT_PROVIDER, action_prompt(project, task, feedback),
                               logs / f"{label}-act.jsonl", plan=False, timeout_seconds=args.timeout)
            if git(project, "rev-parse", "HEAD") != current_head:
                raise RuntimeError("Implementer changed Git history. Stop and inspect changes.")
            build_ok, build_report, changed = tests_and_diff(project, logs, label)
            review = cline_run(project, PLAN_PROVIDER, review_prompt(project, task, result, build_ok, build_report, changed),
                               logs / f"{label}-review.jsonl", plan=True, timeout_seconds=args.timeout)
            (logs / f"{label}-review.md").write_text(review, encoding="utf-8")
            verdict = verdict_from(review)
            if not build_ok and verdict == "PASS":
                verdict = "FIX"
                review = "VERDICT: FIX\nBuild failed, regardless of reviewer answer.\n" + build_report[-3000:]
            print("\n" + review[:2500], flush=True)
            if verdict == "PASS":
                if not changed:
                    raise RuntimeError("Reviewer returned PASS but no source changes exist.")
                commit_milestone(project, milestone, task, review)
                print("Accepted and saved as a local Git checkpoint.", flush=True)
                break
            if verdict == "BLOCK":
                raise RuntimeError("Reviewer reported BLOCK. See " + str(logs / f"{label}-review.md"))
            if attempt == args.fixes:
                raise RuntimeError(f"Correction limit reached for milestone {milestone}; code remains uncommitted for inspection.")
            feedback = review
            print("Requesting Claude corrections...", flush=True)
    print("\nCompleted requested milestones. Inspect the game manually before the next run.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired, OSError, KeyboardInterrupt) as exc:
        print(f"\nSTOPPED: {exc}", file=sys.stderr)
        sys.exit(1)
