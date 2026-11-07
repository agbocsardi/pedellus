import { clearScreenDown, cursorTo, moveCursor, type Interface } from "node:readline";
import type { Writable } from "node:stream";
import type { TerminalDisplay } from "./index.js";

/**
 * Let readline redraw the entire editable block, including transient assistant text. Its native
 * wrapping, Unicode widths and cursor bookkeeping must also own the spinner: moving up a fixed
 * number of rows corrupts wrapped input. Only newline-completed output becomes permanent text.
 */
export function ownerDisplay(input: Interface, output: Writable): TerminalDisplay {
  let drawn = false;
  let closed = false;
  const onClose = () => { closed = true; };
  input.once("close", onClose);
  // Node's typings mark these public fields readonly; an empty native redraw needs a temporary
  // view of them. Restore them synchronously, without emitting keypresses or changing undo history.
  const buffer = input as { line: string; cursor: number; prevRows?: number };
  // Node's append fast path can wrap without updating its redraw cache. Synchronize from the
  // actual cursor BEFORE changing the prompt, including before readline's own resize handler.
  const synchronizeRows = () => { if (drawn) buffer.prevRows = input.getCursorPos().rows; };
  output.prependListener("resize", synchronizeRows);
  let status: string | undefined;
  let partial = "";
  const promptText = () => `${partial ? `${partial}\n` : ""}${status ? `You [${status}]: ` : "You: "}`;
  const prompt = () => {
    if (closed) return;
    synchronizeRows();
    input.setPrompt(promptText());
    input.prompt(true);
    drawn = true;
  };
  const erasePrompt = () => {
    if (!drawn) return;
    if (closed) {
      // Do not call prompt() after close: it resumes stdin and can prevent Ctrl-C from exiting.
      moveCursor(output, 0, -input.getCursorPos().rows);
      cursorTo(output, 0);
      clearScreenDown(output);
      drawn = false;
      return;
    }
    // A native empty redraw clears every occupied row and resets readline's previous-row count.
    // Restore the public buffer/cursor without echoing them until the next prompt is drawn.
    synchronizeRows();
    const { line, cursor } = input;
    buffer.line = "";
    buffer.cursor = 0;
    input.setPrompt("");
    try {
      input.prompt(true);
    } finally {
      buffer.line = line;
      buffer.cursor = cursor;
      input.setPrompt(promptText());
      drawn = false;
    }
  };
  const onLine = (submitted: string) => {
    if (drawn) {
      // Enter moved to a fresh row and cleared readline's buffer. Reconstruct the submitted
      // block's height, then commit it without the transient spinner in the owner's label.
      const { line, cursor } = input;
      buffer.line = submitted;
      buffer.cursor = submitted.length;
      let rows: number;
      try {
        rows = input.getCursorPos().rows + 1;
      } finally {
        buffer.line = line;
        buffer.cursor = cursor;
      }
      moveCursor(output, 0, -rows);
      cursorTo(output, 0);
      clearScreenDown(output);
      output.write(`${partial ? `${partial}\n` : ""}You: ${submitted}\n`);
    }
    drawn = false;
    partial = "";
    input.setPrompt(promptText());
  };
  input.on("line", onLine);
  return {
    interactive: true,
    prompt,
    erasePrompt,
    status(text) {
      if (status === text) return;
      status = text;
      if (drawn) prompt();
    },
    write(text, target) {
      erasePrompt();
      const combined = partial + text;
      partial = "";
      if (closed) return target.write(combined);
      const newline = combined.lastIndexOf("\n");
      const ready = newline < 0 || target.write(combined.slice(0, newline + 1));
      partial = combined.slice(newline + 1);
      prompt();
      return ready;
    },
    close() {
      erasePrompt();
      if (partial) output.write(`${partial}\n`);
      partial = "";
      input.removeListener("line", onLine);
      input.removeListener("close", onClose);
      output.removeListener("resize", synchronizeRows);
    },
  };
}
