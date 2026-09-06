import { expect, test } from "bun:test";
import {
  lookupGitHubRepositoryDisplay,
  parseGitHubRepositoryDisplay,
} from "./github-repository";

test("parses a GitHub repository display name from the public API payload", () => {
  expect(
    parseGitHubRepositoryDisplay({
      full_name: "LSP-Software/DotRelay",
      name: "DotRelay",
      owner: { login: "LSP-Software" },
    }),
  ).toEqual({ owner: "LSP-Software", name: "DotRelay" });
});

test("looks up a GitHub repository display name once and caches it", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ full_name: "LSP-Software/DotRelay" });
  }) as typeof fetch;

  const first = await lookupGitHubRepositoryDisplay("4242424242", fetchImpl);
  const second = await lookupGitHubRepositoryDisplay("4242424242", fetchImpl);

  expect(first).toEqual({ owner: "LSP-Software", name: "DotRelay" });
  expect(second).toEqual(first);
  expect(calls).toEqual(["https://api.github.com/repositories/4242424242"]);
});
