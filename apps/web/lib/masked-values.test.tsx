import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VariableRow } from "./environment-editor-views";
import type { EnvironmentVariable } from "./environment-workflow";

// A masked Value must not be in the document: React mirrors a controlled
// input's value into the HTML attribute, where page capture, "save page"
// and CSS attribute selectors can read it before anyone reveals it.
const SECRET = "sk-live-do-not-leak-0123456789";

const variable: EnvironmentVariable = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "API_KEY",
  description: "",
  ownership: "SHARED_VALUE",
  value: SECRET,
  required: true,
  hasDraftChange: false,
};

const row = (revealed: boolean) =>
  renderToStaticMarkup(
    <VariableRow
      canDelete
      canEdit
      canUndoDelete={false}
      editingDisabled={false}
      onDelete={() => undefined}
      onSetAbsent={() => undefined}
      onToggleReveal={() => undefined}
      onUndoDelete={() => undefined}
      onValueChange={() => undefined}
      readOnlyDisclosure={null}
      revealed={revealed}
      variable={variable}
    />,
  );

describe("masked Values stay out of the DOM", () => {
  test("a masked row renders no plaintext", () => {
    expect(row(false)).not.toContain(SECRET);
  });

  test("a revealed row renders no value attribute either", () => {
    // The live input receives the Value as a property after mount.
    expect(row(true)).not.toContain(SECRET);
  });
});
