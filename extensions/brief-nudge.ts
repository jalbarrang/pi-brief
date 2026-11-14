/**
 * Reply-shape nudge.
 *
 * Adds a `reply_shape` section to the system prompt on every run. It states the
 * shape once, up front. `/brief` is the correction for the times the model
 * ignores it anyway.
 *
 * No enforcement on purpose. Truncating a reply mid-thought is worse than a long
 * reply, and re-asking automatically doubles tokens on every verbose turn. The
 * cheap fix is a nudge, then one explicit correction when it fails.
 *
 * The section is set rather than returned as `systemPrompt`, so pi diffs sections
 * and patches only the changed one instead of replacing the whole prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = [
  "Prefer short replies. The answer is the first sentence; if it is yes or no, that is sentence one.",
  "Skip preambles, restatements of the question, closing summaries, and offers to do more.",
  "Plain words: English is a second language here, so skip jargon or define it in a clause.",
  "If a reply would run long, give the short version and let the question come back.",
].join("\n");

export default function briefNudge(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.reply_shape = SECTION;
  });
}
