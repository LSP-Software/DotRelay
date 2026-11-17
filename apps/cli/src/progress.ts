import { bar, elapsed, stepDone, stepFail } from "./components";
import { paint, terminalWidth, truncate, visibleWidth } from "./theme";
import { rewriteRegion } from "./ui";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type ProgressOptions = Readonly<{
  readonly output: NodeJS.WritableStream;
  readonly live: boolean;
  readonly quiet?: boolean;
  /** Clock for the timings; tests pass a fixed one. */
  readonly now?: () => number;
  /**
   * Clear the spinner instead of leaving a settled line, for a command
   * whose result card is written elsewhere (stdout) afterwards.
   */
  readonly transient?: boolean;
}>;

export type Progress = Readonly<{
  readonly start: (label: string) => void;
  readonly done: (label: string) => void;
  readonly fail: (label: string) => void;
}>;

/**
 * One step at a time on the rail. A live terminal sees a spinner with the
 * time so far; every terminal sees the settled line, `◇  label  0.8s` or
 * `■  label`, followed by the rail.
 */
export const createProgress = (options: ProgressOptions): Progress => {
  const { output, live, quiet } = options;
  const now = options.now ?? (() => performance.now());
  let frame = 0;
  let label = "";
  let startedAt = now();
  let lines = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const draw = (): void => {
    const mark = paint(FRAMES[frame % FRAMES.length] ?? "⠋", "brand");
    // The spinner line stays on one row so each redraw clears it exactly.
    const head = `${mark}  ${truncate(label, Math.max(8, terminalWidth() - 4))}`;
    const time = elapsed(now() - startedAt);
    const gap = terminalWidth() - 2 - visibleWidth(head) - time.length;
    lines = rewriteRegion(
      output,
      lines,
      gap > 1 ? `${head}${" ".repeat(gap)}${paint(time, "faint")}` : head,
    );
  };

  const settle = (state: "done" | "fail", finalLabel: string): void => {
    stop();
    const frozen = `${
      state === "fail"
        ? stepFail(finalLabel)
        : stepDone(finalLabel, active ? now() - startedAt : undefined)
    }\n${bar()}`;
    if (quiet) {
      active = false;
      return;
    }
    if (options.transient && state === "done") {
      if (active && live && lines > 0) {
        output.write(`\x1b[${lines}F\x1b[0J`);
      }
      active = false;
      lines = 0;
      return;
    }
    if (active && live) lines = rewriteRegion(output, lines, frozen);
    else output.write(`${frozen}\n`);
    active = false;
    lines = 0;
  };

  return {
    start: (next: string) => {
      label = next;
      startedAt = now();
      active = true;
      if (quiet || !live) return;
      frame = 0;
      lines = 0;
      draw();
      timer = setInterval(() => {
        frame += 1;
        draw();
      }, 80);
    },
    done: (next: string) => settle("done", next),
    fail: (next: string) => settle("fail", next),
  };
};
