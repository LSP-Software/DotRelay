import { describe, expect, test } from "bun:test";
import {
  ENCRYPTION_PASSWORD_MIN_LENGTH,
  encryptionPasswordAdvice,
  encryptionPasswordProblem,
} from "./password-policy";

describe("encryption password policy", () => {
  test("needs at least twelve characters", () => {
    expect(ENCRYPTION_PASSWORD_MIN_LENGTH).toBe(12);
    for (const password of ["", "hunter2", "Tr0ub4dor&3", "eleven-char"])
      expect(encryptionPasswordProblem(password)).toBe("too-short");
    // Code points, not UTF-16 units.
    expect(encryptionPasswordProblem("🔑".repeat(11))).toBe("too-short");
    expect(encryptionPasswordProblem("x".repeat(1025))).toBe("too-long");
  });

  test("refuses repeated, sequential and all-number patterns", () => {
    for (const password of [
      "aaaaaaaaaaaa",
      "abcabcabcabc",
      "123456789012",
      "000000000000000",
      "abcdefghijklm",
      "zyxwvutsrqpo",
      "qwertyuiopas",
      "1q2w3e4r5t6y",
      "asdf asdf asdf",
      "passwordpassword",
    ])
      expect(encryptionPasswordProblem(password)).toBe("too-simple");
  });

  test("refuses common words dressed up with digits, symbols and substitutions", () => {
    for (const password of [
      "Password2024!",
      "P@ssw0rd1234",
      "iloveyou12345",
      "Dotrelay!2026",
      "letmein!!!!!",
      "!!Welcome2024",
      "qwerty123456789",
      "Sup3rman1987!",
    ])
      expect(encryptionPasswordProblem(password)).toBe("too-common");
  });

  test("accepts long, unpredictable passwords", () => {
    for (const password of [
      "correct-horse-battery-9",
      "tangerine river lamp",
      "Zx81!harbor-Quill",
      "my cat eats paper clips",
    ])
      expect(encryptionPasswordProblem(password)).toBeNull();
  });

  test("names a fix for every problem", () => {
    for (const problem of [
      "too-short",
      "too-long",
      "too-simple",
      "too-common",
    ] as const)
      expect(encryptionPasswordAdvice(problem).length).toBeGreaterThan(0);
  });
});
