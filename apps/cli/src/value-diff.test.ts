import { describe, expect, test } from "bun:test";
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
    ).toEqual(["API_KEY  user-defined"]);
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
    ).toBe("CHANGED  shared  updated");
    expect(
      renderMaskedChange(
        { name: "GONE", kind: "removed", ownership: "user-defined" },
        { indent: "" },
      ),
    ).toBe("GONE  user-defined  removed");
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
        "  dotrelay diff",
        "",
        "1 added, 1 updated, 1 removed",
        "",
        "Variable  Ownership     Change",
        "  CHANGED   shared        updated",
        "  NEW       —             added",
        "  GONE      user-defined  removed",
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
        "  dotrelay diff",
        "",
        "1 added, 1 updated, 1 removed",
        "",
        "CHANGED  shared",
        "-  prev",
        "+  next",
        "",
        "NEW",
        "+  fresh",
        "",
        "GONE  user-defined",
        "-  old",
        "",
      ].join("\n"),
    );
  });

  test("diff with no changes reports an exact match", () => {
    expect(renderEnvDiff([])).toBe(
      [
        "  dotrelay diff",
        "",
        "  ✓  Your .env matches the Environment",
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
        "Variable      Ownership  Change",
        "  DATABASE_URL  shared     updated",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(reviewBody(changes, destination, true)).toBe(
      [
        "1 updated",
        "",
        "  DATABASE_URL  shared",
        "  -  postgres://secret",
        "  +  abc",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(
      reviewFrame({
        title: `Review — publish to ${destination.environment}`,
        body: reviewBody(changes, destination, false),
        question: publicationConfirmQuestion(),
      }),
    ).toBe(
      [
        "─".repeat(40),
        `  Review — publish to ${destination.environment}`,
        "",
        "  1 updated",
        "",
        "  Variable      Ownership  Change",
        "    DATABASE_URL  shared     updated",
        "",
        "    Profile        relay",
        "    Environment    development",
        "",
        "  Publish? [y/N]",
        "─".repeat(40),
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
        "Variable   Ownership     Change",
        "  NEW_TOKEN  shared        added",
        "  API_KEY    user-defined  removed",
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
      "Roll back the selected Variables? [y/N]",
    );
    expect(reviewBody(changes, destination, false)).toBe(
      [
        "1 updated",
        "",
        "Variable      Ownership  Change",
        "  DATABASE_URL  shared     updated",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(reviewBody(changes, destination, true)).toBe(
      [
        "1 updated",
        "",
        "  DATABASE_URL  shared",
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
        "Variable      Ownership     Change",
        "  DATABASE_URL  shared        updated",
        "  GONE          —             removed",
        "  API_KEY       user-defined  added",
        "",
        ...destinationKv,
      ].join("\n"),
    );
    expect(reviewBody(changes, destination, true)).toBe(
      [
        "1 added, 1 updated, 1 removed",
        "",
        "  DATABASE_URL  shared",
        "  -  postgres://local",
        "  +  postgres://secret",
        "",
        "  GONE",
        "  -  old",
        "",
        "  API_KEY  user-defined",
        "  +  tok",
        "",
        ...destinationKv,
      ].join("\n"),
    );
  });
});
