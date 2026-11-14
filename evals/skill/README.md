# Skill evals

Does a resource actually change behavior, or does it only read well?

Each case is a realistic prompt against a fixture checkout, run twice: once with the
skill loaded (`with_skill`) and once without (`without_skill`). The delta is the only
number worth reading. A case that passes in both configs measures nothing; a case that
fails in both is usually a broken assertion.

Assertions grade the **transcript**, not the prose, because the value is what it makes
the agent do. For `brief` that means counting lines and reading the injected system
prompt section, not admiring the tone.

## Layout

```
evals/skill/
  README.md              this file
  run-evals.ts           one isolated pi session per case × config × trial
  grade-evals.ts         re-grade a finished iteration, zero model calls
  lib/                   types, run, trace, grade, fixtures, benchmark
  <subject>/             one directory per skill
    evals.json           skill path + configs + cases + assertions
    fixtures/<name>/     fixture.json, repo/, optional responses/ and bin/
    workspace/           iteration artifacts (gitignored)
```

`evals.json` names the extension it tests (`"extension": "extensions/brief-nudge.ts"`),
relative to the repo root, so one harness serves every subject here.

## Running

```bash
bun run eval                                   # one trial, both configs
bun run eval -- --dry-run                      # materialize fixtures, print commands
bun run eval -- --subject brief --cases two-line-answer
bun run eval -- --trials 3 --model anthropic/claude-sonnet-4-5
bun run eval:grade -- --iteration 2            # re-grade, no model calls
```

Artifacts land in `<subject>/workspace/iteration-N/`. Each run keeps
`transcript.jsonl` (raw), `trace.json` (parsed), `output.md` (what the user saw),
`grade.json` (assertions + evidence), `timing.json`.

Read a few transcripts before trusting the numbers. A green benchmark over a case the
skill was supposed to make impossible is a bad assertion, not a good skill.

## Isolation

The fixture lives under the OS temp dir, never inside this checkout, and the child runs
under `sandbox-exec` with this repository denied for both reads and writes. Both halves
matter. A cwd inside the repo tells the agent where the skill lives, and an absolute
`--skill` path leaks the repository: the agent reads `SKILL.md`, walks up from there,
finds `evals.json`, and reads the assertions for its own case. Deny the repository and
copy the skill into the fixture, or the eval grades reading comprehension.

The extension is copied into the fixture for `with_extension` runs only. A baseline
that can find the extension on disk is not a baseline.

## Fixtures

`repo/` is committed as the clean baseline. A fixture may also ship `responses/` and
`bin/` for a scripted CLI stand-in; those are staged next to the fixture, never pointed
at from this checkout, and `EVAL_STUB_DIR` tells the stub where its responses live. A
subject that needs no CLI (like `brief`) simply has no `bin/`.

## Assertion kinds

Few on purpose. Add one only when a case cannot be expressed with what is here.

| kind | checks |
| --- | --- |
| `tool_called` / `tool_not_called` | the call happened, or never did |
| `tool_args` | argument subset match; `absent` for "no extra flags" |
| `tool_args_contains` | a substring of one argument, optionally also of its output |
| `tool_order` | `before` ran, and before `after`; `afterRequired: false` for conditional ones |
| `tool_not_called_matching` | no call touched a path or command substring |
| `tool_result_text` | what the tool returned |
| `assistant_text` | what the user saw; `includes` / `excludes` / `matches` / `notMatches` |
| `reply_shape` | countable units: `maxLines`, `minLines`, `maxSentences` |
| `file_text` | a file on disk after the run, relative to the fixture root |
| `system_prompt_section` | a named system prompt section; SKIPs when the extension is absent |

`reply_shape` is what makes a brevity skill measurable. `minLines` exists for the guard
case: a `brief` that also shortens a requested walkthrough is a regression, and only a
floor catches that.

## Known limitations

- **`--no-context-files`.** Runs disable `AGENTS.md`, which is the only way to keep the
  operator's own global instructions from steering a case. The cost is real: the
  always-on brevity contract lives in `AGENTS.md` and, for pi, in this extension's
  `reply_shape` section. These cases measure the extension alone.
- **The walkthrough guard passes in both configs** on a model that was going to be
  verbose anyway. It is a regression guard, not a signal.
- **No unit test for the grader.** `lib/grade.ts` is a port of pi-designer's, which has
  one; this copy does not. A real run is the current test.
- **Not in CI.** Every case is a model call. Wire it to a scheduled job, not to a
  pre-commit hook.
