import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { reviewFrame } from "./components";
import {
  destinationRows,
  publicationConfirmQuestion,
  pullConfirmQuestion,
  renderEnvDiff,
  renderMaskedChange,
  renderValueDiff,
  reviewBody,
  rollbackConfirmQuestion,
  valueDiffsForPull,
  pullReplacementNotes,
} from "./value-diff";

const destination = {
  profile: "relay",
  team: "Platform",
  project: "55555555-5555-4555-8555-555555555555",
  environment: "development",
};
const destinationKv = [
  "  Profile        relay",
  "  Environment    development",
];

describe("CLI value diffs", () => {
  test("masks Values until the caller explicitly reveals them", () => {
    expect(
      renderValueDiff(
        {
          name: "DATABASE_URL",
          from: "postgres://old@host/db",
          to: "postgres://new@host/db",
        },
        { indent: "" },
      ),
    ).toEqual(["DATABASE_URL"]);
    expect(
      renderValueDiff(
        {
          name: "API_KEY",
          from: "tok",
          to: "new-tok",
          ownership: "user-defined",
        },
        { indent: "" },
      ),
    ).toEqual(["API_KEY  Only me"]);
    expect(
      renderValueDiff(
        {
          name: "DATABASE_URL",
          from: "postgres://old@host/db",
          to: "postgres://new@host/db",
        },
        { indent: "", reveal: true },
      ),
    ).toEqual([
      "DATABASE_URL",
      "-  postgres://old@host/db",
      "+  postgres://new@host/db",
    ]);
    expect(
      renderValueDiff(
        { name: "FLAG", from: "abc", to: "abcd" },
        {
          indent: "",
          reveal: true,
        },
      ),
    ).toEqual(["FLAG", "+  abcd"]);
  });

  test("masked changes list name, ownership, and change type", () => {
    expect(
      renderMaskedChange({ name: "NEW", kind: "added" }, { indent: "" }),
    ).toBe("NEW  added");
    expect(
      renderMaskedChange(
        { name: "CHANGED", kind: "updated", ownership: "shared" },
        { indent: "" },
      ),
    ).toBe("CHANGED  Team  updated");
    expect(
      renderMaskedChange(
        { name: "GONE", kind: "removed", ownership: "user-defined" },
        { indent: "" },
      ),
    ).toBe("GONE  Only me  removed");
  });

  test("labels empty and unset Values only when revealed", () => {
    expect(
      renderValueDiff(
        { name: "EMPTY", from: "", to: "filled" },
        { indent: "" },
      ),
    ).toEqual(["EMPTY"]);
    expect(
      renderValueDiff(
        { name: "EMPTY", from: "", to: "filled" },
        {
          indent: "",
          reveal: true,
        },
      ),
    ).toEqual(["EMPTY", "+  filled"]);
    expect(
      renderValueDiff(
        { name: "OPTIONAL", from: "was", to: null },
        { indent: "", reveal: true },
      ),
    ).toEqual(["OPTIONAL", "-  was", "+  not set"]);
  });

  test("diff human output masks Values but keeps names and change types", () => {
    expect(
      renderEnvDiff([
        {
          kind: "updated",
          name: "CHANGED",
          localValue: "next",
          remoteValue: "prev",
          ownership: "shared",
        },
        {
          kind: "added",
          name: "NEW",
          localValue: "fresh",
          remoteValue: null,
        },
        {
          kind: "removed",
          name: "GONE",
          localValue: null,
          remoteValue: "old",
          ownership: "user-defined",
        },
      ]),
    ).toBe(
      [
        "┌  dotrelay diff",
        "│",
        "◇  3 differences from the environment  1 added, 1 updated, 1 removed",
        "│",
        "│     Variable  Who      Change",
        "│  ~  CHANGED   Team     updated",
        "│  +  NEW       —        added",
        "│  −  GONE      Only me  removed",
        "│",
        "└  Values are hidden. Add --reveal to see them.",
        "",
      ].join("\n"),
    );
  });

  test("diff human output reveals the unified diff on request", () => {
    expect(
      renderEnvDiff(
        [
          {
            kind: "updated",
            name: "CHANGED",
            localValue: "next",
            remoteValue: "prev",
            ownership: "shared",
          },
          {
            kind: "added",
            name: "NEW",
            localValue: "fresh",
            remoteValue: null,
          },
          {
            kind: "removed",
            name: "GONE",
            localValue: null,
            remoteValue: "old",
            ownership: "user-defined",
          },
        ],
        true,
      ),
    ).toBe(
      [
        "┌  dotrelay diff",
        "│",
        "◇  3 differences from the environment  1 added, 1 updated, 1 removed",
        "│",
        "│  CHANGED  Team",
        "│  -  prev",
        "│  +  next",
        "│",
        "│  NEW",
        "│  +  fresh",
        "│",
        "│  GONE  Only me",
        "│  -  old",
        "│",
        "└",
        "",
      ].join("\n"),
    );
  });

  test("diff with no changes reports an exact match", () => {
    expect(renderEnvDiff([])).toBe(
      [
        "┌  dotrelay diff",
        "│",
        "└  Your .env matches the environment",
        "",
      ].join("\n"),
    );
  });

  test("publication confirmation masks Values until reveal is explicit", () => {
    const changes = [
      {
        kind: "updated" as const,
        name: "DATABASE_URL",
        from: "postgres://secret",
        to: "abc",
        ownership: "shared" as const,
      },
    ];
    expect(publicationConfirmQuestion()).toBe("Publish? [y/N]");
    expect(reviewBody(changes, destination, false)).toBe(
      [
        "1 updated",
        "",
        "     Variable      Who   Change",
        "  ~  DATABASE_URL  Team  updated",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(reviewBody(changes, destination, true)).toBe(
      [
        "1 updated",
        "",
        "  DATABASE_URL  Team",
        "  -  postgres://secret",
        "  +  abc",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(
      reviewFrame({
        title: `Publish to ${destination.environment}`,
        body: reviewBody(changes, destination, false),
        question: publicationConfirmQuestion(),
      }),
    ).toBe(
      [
        `◇  Publish to ${destination.environment}`,
        "│",
        "│  1 updated",
        "│",
        "│     Variable      Who   Change",
        "│  ~  DATABASE_URL  Team  updated",
        "│",
        "│  Profile        relay",
        "│  Environment    development",
        "│",
        "◆  Publish? [y/N]",
      ].join("\n"),
    );
    expect(
      reviewBody(
        [
          {
            kind: "added",
            name: "NEW_TOKEN",
            from: undefined,
            to: "fresh",
            ownership: "shared",
          },
          {
            kind: "removed",
            name: "API_KEY",
            from: "tok",
            to: undefined,
            ownership: "user-defined",
          },
        ],
        destination,
        false,
      ),
    ).toBe(
      [
        "1 added, 1 removed",
        "",
        "     Variable   Who      Change",
        "  +  NEW_TOKEN  Team     added",
        "  −  API_KEY    Only me  removed",
        "",
        ...destinationKv,
      ].join("\n"),
    );
  });

  test("rollback confirmation names the append-only consequence", () => {
    const changes = [
      {
        kind: "updated" as const,
        name: "DATABASE_URL",
        from: "postgres://secret",
        to: "abc",
        ownership: "shared" as const,
      },
    ];
    expect(rollbackConfirmQuestion()).toBe(
      "Roll back the selected variables? [y/N]",
    );
    expect(reviewBody(changes, destination, false)).toBe(
      [
        "1 updated",
        "",
        "     Variable      Who   Change",
        "  ~  DATABASE_URL  Team  updated",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(reviewBody(changes, destination, true)).toBe(
      [
        "1 updated",
        "",
        "  DATABASE_URL  Team",
        "  -  postgres://secret",
        "  +  abc",
        "",
        ...destinationKv,
      ].join("\n"),
    );
  });

  test("sanitizes control characters in every destination line", () => {
    const hostile = {
      profile: "relay\u001b[31m",
      team: "Platform\u001b]0;evil\u0007",
      project: "55555555\u0000",
      environment: "development\u001b[2J",
    };
    expect(reviewBody(null, hostile, true)).toBe(
      ["  Profile        relay[31m", "  Environment    development[2J"].join(
        "\n",
      ),
    );
  });

  test("destination rows drop internal identifiers", () => {
    expect(destinationRows(destination)).toEqual([
      { key: "Profile", value: destination.profile, tone: undefined },
      { key: "Environment", value: destination.environment, tone: undefined },
    ]);
  });

  test("confirmation without a diff still identifies the destination", () => {
    expect(pullConfirmQuestion(".env")).toBe(
      "Replace .env with decrypted values? [y/N]",
    );
  });

  test("pull confirmation masks the replacement diff by default", () => {
    const changes = valueDiffsForPull([
      {
        kind: "updated",
        name: "DATABASE_URL",
        localValue: "postgres://local",
        remoteValue: "postgres://secret",
        ownership: "shared",
      },
      {
        kind: "added",
        name: "GONE",
        localValue: "old",
        remoteValue: null,
      },
      {
        kind: "removed",
        name: "API_KEY",
        localValue: null,
        remoteValue: "tok",
        ownership: "user-defined",
      },
    ]);
    expect(changes).toEqual([
      {
        kind: "updated",
        name: "DATABASE_URL",
        from: "postgres://local",
        to: "postgres://secret",
        ownership: "shared",
      },
      { kind: "removed", name: "GONE", from: "old", to: undefined },
      {
        kind: "added",
        name: "API_KEY",
        from: undefined,
        to: "tok",
        ownership: "user-defined",
      },
    ]);
    expect(reviewBody(changes, destination, false)).toBe(
      [
        "1 added, 1 updated, 1 removed",
        "",
        "     Variable      Who      Change",
        "  ~  DATABASE_URL  Team     updated",
        "  −  GONE          —        removed",
        "  +  API_KEY       Only me  added",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(reviewBody(changes, destination, true)).toBe(
      [
        "1 added, 1 updated, 1 removed",
        "",
        "  DATABASE_URL  Team",
        "  -  postgres://local",
        "  +  postgres://secret",
        "",
        "  GONE",
        "  -  old",
        "",
        "  API_KEY  Only me",
        "  +  tok",
        "",
        ...destinationKv,
      ].join("\n"),
    );
  });
});

describe("pull replacement notes", () => {
  const plain = (lines: readonly string[]) =>
    stripVTControlCharacters(lines.join("\n"));

  test("names unpushed local edits apart and never their Values", () => {
    const text = plain(
      pullReplacementNotes(".env", [
        { name: "API_TOKEN", kind: "updated" },
        { name: "LOCAL_ONLY", kind: "added" },
      ]),
    );
    expect(text).toContain(
      "Changes you haven't pushed. This pull replaces them:",
    );
    expect(text).toContain("API_TOKEN  edited locally");
    expect(text).toContain("LOCAL_ONLY  added locally");
    expect(text).toContain("dotrelay push first");
    expect(text).toContain(
      "Comments, blank lines and the order of entries in .env aren't kept.",
    );
  });

  test("says when unpushed edits cannot be told apart", () => {
    const text = plain(pullReplacementNotes(".env", null));
    expect(text).toContain("No pull has been recorded for .env");
    expect(text).not.toContain("will be lost");
  });
});
