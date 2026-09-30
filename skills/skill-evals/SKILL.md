---
name: skill-evals
description: Use this when the user wants to evaluate a skill inside SLICC, measure whether a skill helps an agent, run a skill's evals/slicc/tasks.json, compare with vs without a skill, get the skill's lift in score, time and cost, or show eval results as a dip, a sprinkle, or a Hugging Face upload. Triggers on "run the evals for <skill>", "does this skill help", "skill lift", "eval this skill in slicc", "skill-evals". Covers the cone's procedure (validate, plan, human asks, one harness scoop, preflight per condition, serial run-one and judge, report, present, publish), what the judge sees, and cost. Not for the GitHub Actions evals in evals/host/ (the skill-evals workflow runs those).
allowed-tools: bash
---

# skill-evals: evaluate a skill inside SLICC

`skill-evals` runs a skill's `evals/slicc/tasks.json` (format: CLAUDE.md "Skill evals",
validated by `scripts/evals-format.js`). Each task runs as one `agent` WITHOUT the skill and
one WITH it; a separate `agent` judges each transcript against the task's rubric; the report
gives per-task scores and the with-minus-without lift in score, time and cost.

## Procedure (the cone)

1. `skill-evals validate <skill|dir|tasks.json>`. Fix every error first.
2. `skill-evals plan <skill> [--repeats N] [--tasks id,id] [--model m] [--judge-model m]`.
   It freezes the set and the skill (without `evals/`) into the private dir, writes
   `/tmp/skill-evals/<run-id>/plan.json`, and prints three lists:
   - `ask before` / `ask after`: put each one to the human yourself (logins, accounts); the
     harness never asks. `run-one` re-runs a setup ask's `check` and fails the run if it fails.
   - `cone`: steps only you can do, e.g. moving an INSTALLED skill out of `/workspace/skills`
     for `without` (every scoop lists an installed skill; a staged copy cannot hide or replace it).
   - `harness scoop`: the `scoop_scoop` settings below.
3. Create ONE harness scoop named `skill-evals` with the plan's `writablePaths` (its folder,
   `/shared/`, and the fixture roots such as `/workspace/eval/`; without them every fixture
   write escalates to you) and tell it to pass `background_after` >= the plan's
   `bash_background_after` on each bash call. Feed it the run id and this loop:
   `skill-evals status <run-id>`, run the printed `next` command, repeat until `next` is
   `report`. It must stay otherwise idle: cost is the delta of its own `cost` row.
4. The loop does, in order: `preflight <run-id> without`, `run-one`/`judge` for each without run,
   `preflight <run-id> with`, the with runs, then `report <run-id>` and `cleanup <run-id>`.
5. Show results: `skill-evals present <run-id> --dip` writes `report.dip.shtml`; inline its
   content in a `shtml` block. `--sprinkle` installs `/shared/sprinkles/skill-evals/`; the
   `skill-evals` scoop owns that sprinkle and runs `sprinkle open skill-evals`.
6. Publish only if the human asks: `skill-evals publish <run-id> --hf --dry-run` lists the
   files, then without `--dry-run` it uploads to `ai-ecoverse/skill-evals` using `HF_TOKEN`
   (get it with `request_secret`, domain `huggingface.co`).

## What each command guarantees

- `preflight without`: refuses if `/workspace/skills/<name>` exists or another run's stage is
  visible, removes this run's stage, then a one-turn probe `agent` (cheap model) must report the
  skill NOT listed. `preflight with`: stages the frozen copy at
  `/tmp/skill-evals/<run-id>/.agents/skills/<name>/` and the probe must list THAT path.
  The result is in `preflight-<condition>.json`; `run-one` refuses a different condition.
- `run-one <run-id> <n>`: ONE bash call. Stages `slicc.files` (refuses to overwrite an existing
  file), runs `setup` steps, runs `timeout <T> agent --model <m> <fixture dir> '*'
  "[eval-run <uuid>] <task>"`, measures wall time and the row delta, finds the transcript by
  the nonce, moves it to the private dir, runs `teardown`, writes `records/<n>.json`. Flags:
  `attribution: contaminated` (row turns != transcript turns), `timedOut` + `cost_lower_bound`.
- `judge <run-id> <n>`: `agent --thinking low --schema-b64 <schema> --no-persist-session` with
  the task, the rubric and the transcript. Returns met / violated / not_assessable plus
  evidence per item. It retries once. Two failures are a judge error, never a score. Scores follow
  slicc's runner: the weight of met items / 100, so not_assessable earns nothing.
- `report`: `report.json` + `report.md`, per task x condition n, scores, outcomes, time, cost,
  lift (`conclusive` only with >= 2 repeats per task), spend split into tasks / judges / probes.

## What the judge can and cannot see

It sees the task text, the rubric (never the weights), and the transcript. The transcript holds
every message, every tool call with its full input, and every tool result. The judge also sees
the final answer. It does NOT see the system prompt (so not whether the skill was listed; the
preflight proves that), thinking, files the agent never printed, time, or cost. Write rubric
items that a tool call or printed output can prove.

## Privacy and isolation

- Task agents can read `/workspace/`, `/tmp/`, `/shared/` and their own cwd. So the frozen set
  (with its rubrics), transcripts and judge evidence live in `$HOME/skill-evals/<run-id>/` of the
  harness scoop. They never go in `/tmp`. The judge and the probe keep no transcript.
- Transcripts come from the user's real browser. They never leave the machine. `publish`
  uploads only `report.json`, `report.md` and records stripped of free text: ids, condition,
  scores, statuses, metrics. It refuses `ai-ecoverse/slicc-bench`.
- Runs are serial. Staging is global, so a `with` run must never overlap a `without` run of the
  same skill. `&` in one shell is sequential anyway.

## Cost

Measured 2026-09-30 on haiku: a probe or judge costs about $0.03-0.05. Each spawn pays about
24k cache-write tokens of system prompt. A short task run costs $0.05-0.50. Budget per run of
the plan: task + judge. Add two probes per condition switch.

## Known limits

- slicc#3690: a `description: |` or `>` block scalar reaches agents as a bare `|`. A `with`
  agent then sees only the name and path, so the lift measures that. `report` notes it.
- One repeat is never a finding. slicc's own test-retest correlation is r = 0.78, about 0.17 per run.
