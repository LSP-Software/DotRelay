import { describe, expect, test } from "bun:test";
import {
  publicationConfirmQuestion,
  pullConfirmQuestion,
  renderEnvDiff,
  renderValueDiff,
  valueDiffsForPull,
} from "./value-diff";

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

  test("publication confirmation shows the same unified diff", () => {
    expect(
      publicationConfirmQuestion([
        {
          kind: "updated",
          name: "DATABASE_URL",
          from: "postgres://secret",
          to: "abc",
        },
      ]),
    ).toBe(
      [
        "1 variable being updated",
        "  DATABASE_URL",
        "  -  postgres://secret",
        "  +  abc",
        "Publish?",
      ].join("\n"),
    );
    expect(
      publicationConfirmQuestion([
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
      ]),
    ).toBe(
      [
        "1 variable being added, 1 variable being removed",
        "  NEW_TOKEN",
        "  +  fresh",
        "",
        "  API_KEY",
        "  -  tok",
        "Publish?",
      ].join("\n"),
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
    expect(pullConfirmQuestion(".env", changes)).toBe(
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
        "Replace .env with decrypted Values?",
      ].join("\n"),
    );
  });
});
