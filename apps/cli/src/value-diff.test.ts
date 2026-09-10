import { describe, expect, test } from "bun:test";
import {
  publicationConfirmQuestion,
  pullConfirmQuestion,
  renderEnvDiff,
  renderValueDiff,
  valueDiffsForPull,
} from "./value-diff";

const destination = {
  profile: "relay",
  team: "Platform",
  project: "55555555-5555-4555-8555-555555555555",
  environment: "development",
};
const destinationLines = [
  `Profile: ${destination.profile}`,
  `Team: ${destination.team}`,
  `Project: ${destination.project}`,
  `Environment: ${destination.environment}`,
];

describe("CLI value diffs", () => {
  test("render a unified diff with the shared prefix and suffix intact", () => {
    expect(
      renderValueDiff(
        {
          name: "DATABASE_URL",
          from: "postgres://old@host/db",
          to: "postgres://new@host/db",
        },
        { indent: "" },
      ),
    ).toEqual([
      "DATABASE_URL",
      "-  postgres://old@host/db",
      "+  postgres://new@host/db",
    ]);
    expect(
      renderValueDiff(
        { name: "FLAG", from: "abc", to: "abcd" },
        { indent: "" },
      ),
    ).toEqual(["FLAG", "+  abcd"]);
  });

  test("label empty and unset Values", () => {
    expect(
      renderValueDiff(
        { name: "EMPTY", from: "", to: "filled" },
        { indent: "" },
      ),
    ).toEqual(["EMPTY", "+  filled"]);
    expect(
      renderValueDiff(
        { name: "OPTIONAL", from: "was", to: null },
        { indent: "" },
      ),
    ).toEqual(["OPTIONAL", "-  was", "+  not set"]);
  });

  test("diff human output lists each Variable as a unified diff", () => {
    expect(
      renderEnvDiff([
        {
          kind: "updated",
          name: "CHANGED",
          localValue: "next",
          remoteValue: "prev",
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
        },
      ]),
    ).toBe(
      [
        "  ·  1 added, 1 updated, 1 removed",
        "",
        "     CHANGED",
        "     -  prev",
        "     +  next",
        "",
        "     NEW",
        "     +  fresh",
        "",
        "     GONE",
        "     -  old",
        "",
      ].join("\n"),
    );
  });

  test("publication confirmation shows the diff and the destination", () => {
    expect(
      publicationConfirmQuestion(
        [
          {
            kind: "updated",
            name: "DATABASE_URL",
            from: "postgres://secret",
            to: "abc",
          },
        ],
        destination,
      ),
    ).toBe(
      [
        "1 variable being updated",
        "  DATABASE_URL",
        "  -  postgres://secret",
        "  +  abc",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    );
    expect(
      publicationConfirmQuestion(
        [
          {
            kind: "added",
            name: "NEW_TOKEN",
            from: undefined,
            to: "fresh",
          },
          {
            kind: "removed",
            name: "API_KEY",
            from: "tok",
            to: undefined,
          },
        ],
        destination,
      ),
    ).toBe(
      [
        "1 variable being added, 1 variable being removed",
        "  NEW_TOKEN",
        "  +  fresh",
        "",
        "  API_KEY",
        "  -  tok",
        "",
        ...destinationLines,
        "Publish?",
      ].join("\n"),
    );
  });

  test("confirmation without a diff still identifies the destination", () => {
    expect(pullConfirmQuestion(".env", null, destination)).toBe(
      [...destinationLines, "Replace .env with decrypted Values?"].join("\n"),
    );
  });

  test("pull confirmation inverts the dotenv diff onto the file being replaced", () => {
    const changes = valueDiffsForPull([
      {
        kind: "updated",
        name: "DATABASE_URL",
        localValue: "postgres://local",
        remoteValue: "postgres://secret",
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
      },
    ]);
    expect(changes).toEqual([
      {
        kind: "updated",
        name: "DATABASE_URL",
        from: "postgres://local",
        to: "postgres://secret",
      },
      { kind: "removed", name: "GONE", from: "old", to: undefined },
      { kind: "added", name: "API_KEY", from: undefined, to: "tok" },
    ]);
    expect(pullConfirmQuestion(".env", changes, destination)).toBe(
      [
        "1 variable being added, 1 variable being updated, 1 variable being removed",
        "  DATABASE_URL",
        "  -  postgres://local",
        "  +  postgres://secret",
        "",
        "  GONE",
        "  -  old",
        "",
        "  API_KEY",
        "  +  tok",
        "",
        ...destinationLines,
        "Replace .env with decrypted Values?",
      ].join("\n"),
    );
  });
});
