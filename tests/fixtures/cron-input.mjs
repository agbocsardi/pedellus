// The host submits a job's own message verbatim as the scheduled occurrence input, in either mode:
// delivery is the job's `silent` setting, never something the run's own answer can switch off. The
// tests keep their own copy rather than importing the implementation, so an appended host
// instruction fails here instead of being matched silently.

/** The content one scheduled occurrence submits for a job's own message. */
export function scheduledContent(message) {
  return message;
}
