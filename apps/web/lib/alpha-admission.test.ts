import { expect, test } from "bun:test";
import {
  alphaAccessRequestHref,
  isAlphaAdmissionProblem,
  isAlphaAdmissionResponse,
} from "./alpha-admission";

test("only a 403 carrying the alpha code is the alpha state", async () => {
  const body = { code: "alpha_admission_required" };
  expect(isAlphaAdmissionProblem(403, body)).toBe(true);
  expect(isAlphaAdmissionProblem(401, body)).toBe(false);
  expect(isAlphaAdmissionProblem(403, { code: "forbidden" })).toBe(false);
  expect(isAlphaAdmissionProblem(403, null)).toBe(false);
  const response = Response.json(body, { status: 403 });
  expect(await isAlphaAdmissionResponse(response)).toBe(true);
  // The body stays readable for the caller.
  expect(await response.json()).toEqual(body);
  expect(
    await isAlphaAdmissionResponse(new Response("nope", { status: 403 })),
  ).toBe(false);
});

test("only the hosted service offers the support address", () => {
  const href = alphaAccessRequestHref(true);
  expect(href).toStartWith("mailto:support@dotrelay.dev?");
  expect(new URLSearchParams(href?.split("?")[1]).get("subject")).toBe(
    "DotRelay alpha access request",
  );
  expect(alphaAccessRequestHref(false)).toBeNull();
});
