import { paint } from "./theme";
import { rewriteRegion } from "./ui";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type ProgressOptions = Readonly<{
  readonly output: NodeJS.WritableStream;
  readonly live: boolean;
  readonly quiet?: boolean;
}>;

export type Progress = Readonly<{
  readonly start: (label: string) => void;
  readonly done: (label: string) => void;
  readonly fail: (label: string) => void;
}>;

export const createProgress = (options: ProgressOptions): Progress => {
  const { output, live, quiet } = options;
  let frame = 0;
  let label = "";
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
    lines = rewriteRegion(output, lines, `  ${mark} ${paint(label, "muted")}`);
  };

  const settle = (state: "done" | "fail", finalLabel: string): void => {
    stop();
    const frozen = paintLine(state, finalLabel);
    if (!active) {
      if (!quiet) output.write(`${frozen}\n`);
      return;
    }
    active = false;
    if (live) lines = rewriteRegion(output, lines, frozen);
    else output.write(`${frozen}\n`);
  };

  const paintLine = (state: "done" | "fail", text: string): string =>
    state === "fail"
      ? `  ${paint("✖", "danger")} ${paint(text, "fg")}`
      : `  ${paint("✓", "brand")} ${paint(text, "fg")}`;

  return {
    start: (next: string) => {
      label = next;
      if (quiet || !live) return;
      if (active) lines = rewriteRegion(output, lines, "");
      active = true;
      frame = 0;
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
