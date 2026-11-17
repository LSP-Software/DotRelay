// PROTOTYPE. The three directions, side by side.
import { live } from "./live";
import { plan } from "./plan";
import { quiet } from "./quiet";

export const DIRECTIONS = {
  quiet: {
    title: "A · Quiet",
    about: "plain sentences, almost no chrome",
    scenes: quiet,
  },
  live: {
    title: "B · Live",
    about: "rail, spinners, progress bars, toggles",
    scenes: live,
  },
  plan: {
    title: "C · Plan",
    about: "a checklist of what's missing, worked through in place",
    scenes: plan,
  },
} as const;
export type DirectionId = keyof typeof DIRECTIONS;
