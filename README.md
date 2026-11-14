# pi-brief

Two things for one problem: the agent talks too much.

1. **A nudge.** An always-on `reply_shape` system prompt section asking for the answer
   first, no preamble, no closing summary, plain words.
2. **A correction.** `/brief` after a reply that ignored the nudge.

## Install

```bash
pi install ./pi-brief          # local checkout
pi install npm:@jalbarrang/pi-brief
```

`/reload` in an active session, or restart.

## What `/brief` does

Sends this, as your turn:

> That was too long, please summarize and be brief in a way my ADHD brain can understand.

followed by the operational part: keep the conclusion, drop the buildup, 3 sentences or
5 lines, no closing offer.

It is a prompt template, not code. The previous reply is already in context, so "redo
your last message" needs no machinery to point at it.

## Why there is no enforcement

A hook could count lines and truncate or re-ask. Both are worse than the problem:
truncation cuts a reply mid-thought, and automatic re-asking doubles tokens on every
verbose turn. The nudge is free, and one explicit correction at the moment of failure
lands harder than a rule stated at the start.

## Layout

```
extensions/brief-nudge.ts   the system prompt section
prompts/brief.md            the /brief command
evals/                      behavioral evals for both
```

## Evals

```bash
bun run eval          # one trial, both configs (with and without the extension)
bun run eval:grade    # re-grade the latest iteration, no model calls
```

See `evals/skill/README.md`.
