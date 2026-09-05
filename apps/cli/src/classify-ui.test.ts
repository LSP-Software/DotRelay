import { describe, expect, test } from "bun:test";
import {
  applyClassificationAction,
  createClassificationBoard,
  renderClassificationBoard,
  toggleClassification,
} from "./classify-ui";

describe("classification board", () => {
  test("defaults unset Variables to shared and toggles ownership", () => {
    const state = createClassificationBoard(["DATABASE_URL", "API_KEY"], {
      API_KEY: "user-defined",
    });
    expect(state.drafts).toEqual([
      { name: "DATABASE_URL", classification: "shared" },
      { name: "API_KEY", classification: "user-defined" },
    ]);
    expect(toggleClassification("shared")).toBe("user-defined");
    expect(
      applyClassificationAction(state, "toggle").drafts.map(
        (draft) => draft.classification,
      ),
    ).toEqual(["user-defined", "user-defined"]);
  });

  test("renders every Variable without exposing Values", () => {
    const board = renderClassificationBoard(
      createClassificationBoard(["DATABASE_URL", "LOCAL_PATH"]),
      { interactive: false },
    );
    expect(board).toContain("DATABASE_URL");
    expect(board).toContain("LOCAL_PATH");
    expect(board).toContain("[shared]");
    expect(board).toContain("user-defined");
    expect(board).not.toContain("secret");
    expect(board).not.toContain("=");
  });

  test("moves the cursor and finishes from a numbered toggle", () => {
    let state = createClassificationBoard(["A", "B", "C"]);
    state = applyClassificationAction(state, "down");
    expect(state.cursor).toBe(1);
    state = applyClassificationAction(state, 2);
    expect(state.drafts[1]?.classification).toBe("user-defined");
    expect(applyClassificationAction(state, "done").done).toBe(true);
  });
});
