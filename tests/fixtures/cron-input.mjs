// The host appends this exact instruction to every scheduled non-digest job message so a
// conditional run can suppress only its own automatic delivery. The tests keep their own copy
// rather than importing the implementation, so a change to the model-facing contract fails here
// instead of being matched silently.
export const SCHEDULED_SILENT_INSTRUCTION =
  "For this scheduled run only, return exactly [SILENT] as your final answer to suppress automatic delivery when there is nothing to report.";

/** The content one scheduled occurrence submits for a job's own message. */
export function scheduledContent(message) {
  return `${message}\n\n${SCHEDULED_SILENT_INSTRUCTION}`;
}
