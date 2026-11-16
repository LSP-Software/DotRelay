// What an encryption password must be before it wraps the Account Master
// Key. A password wrapper is guessable offline by anyone who holds the
// service's database, the operator included (ADR 0009), and Argon2id (64 MiB,
// 3 passes, 1 lane by default) only slows each guess. The policy refuses the
// passwords a guessing attack tries first: short ones, keyboard and
// counting patterns, and common words dressed up with digits and symbols.

/** The fewest characters (Unicode code points) an encryption password may have. */
export const ENCRYPTION_PASSWORD_MIN_LENGTH = 12;
/** A ceiling that keeps the KDF input bounded; no person needs more. */
export const ENCRYPTION_PASSWORD_MAX_LENGTH = 1024;

export type EncryptionPasswordProblem =
  "too-short" | "too-long" | "too-simple" | "too-common";

// Base words that top published password lists are built on. A password that
// is one of them (repeated or not) once digits and symbols at either end are
// removed and common substitutions undone is refused, however long.
const COMMON_WORDS: ReadonlySet<string> = new Set([
  "abc",
  "admin",
  "administrator",
  "access",
  "asdf",
  "baseball",
  "batman",
  "changeme",
  "charlie",
  "computer",
  "default",
  "dotrelay",
  "dragon",
  "football",
  "freedom",
  "github",
  "hello",
  "iloveyou",
  "letmein",
  "login",
  "master",
  "monkey",
  "mustang",
  "password",
  "passphrase",
  "princess",
  "qazwsx",
  "qwerty",
  "secret",
  "shadow",
  "soccer",
  "starwars",
  "sunshine",
  "superman",
  "test",
  "trustno",
  "welcome",
  "whatever",
]);

// Rows and runs a person types without thinking.
const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "01234567890",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "qwertyuiopasdfghjklzxcvbnm",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
  "1q2w3e4r5t6y7u8i9o0p",
  "qazwsxedcrfvtgbyhnujmikolp",
];

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
};

const isSequence = (text: string): boolean =>
  SEQUENCES.some((sequence) => {
    const doubled = sequence.repeat(2);
    const reversed = [...doubled].reverse().join("");
    return doubled.includes(text) || reversed.includes(text);
  });

// True when the text is one short unit repeated, such as "abcabcabcabc".
const isRepetition = (text: string): boolean => {
  for (let unit = 1; unit <= Math.floor(text.length / 2); unit += 1) {
    if (text.length % unit !== 0) continue;
    if (text.slice(0, unit).repeat(text.length / unit) === text) return true;
  }
  return false;
};

const isCommonWord = (text: string): boolean => {
  // Nothing is left of a password with no a-z letters: that is no word.
  if (text.length === 0) return false;
  if (COMMON_WORDS.has(text)) return true;
  // The same word typed two or more times.
  for (const word of COMMON_WORDS)
    if (
      text.length % word.length === 0 &&
      word.repeat(text.length / word.length) === text
    )
      return true;
  return false;
};

/**
 * Why `password` may not wrap the Account Master Key, or null when it may.
 * Used when a password is set and again when one unlocks the account, so a
 * password set under an older, weaker rule is offered a change.
 */
export const encryptionPasswordProblem = (
  password: string,
): EncryptionPasswordProblem | null => {
  const characters = [...password];
  if (characters.length < ENCRYPTION_PASSWORD_MIN_LENGTH) return "too-short";
  if (characters.length > ENCRYPTION_PASSWORD_MAX_LENGTH) return "too-long";
  const lowered = password.toLowerCase();
  const compact = lowered.replaceAll(/[\s_.-]+/g, "");
  if (
    new Set(characters).size < 5 ||
    /^\d+$/.test(compact) ||
    isSequence(compact) ||
    isRepetition(compact)
  )
    return "too-simple";
  const unleet = (text: string): string =>
    [...text].map((character) => LEET[character] ?? character).join("");
  // Removes everything but a-z letters from both ends, in one linear pass.
  const stripEnds = (text: string): string => {
    const isLetter = (index: number): boolean =>
      text.charAt(index) >= "a" && text.charAt(index) <= "z";
    let start = 0;
    let end = text.length;
    while (start < end && !isLetter(start)) start += 1;
    while (end > start && !isLetter(end - 1)) end -= 1;
    return text.slice(start, end);
  };
  // Digits and symbols around a word add little: "Password2024!" is
  // "password" to a guessing tool, and so is "P@ssw0rd" once the usual
  // substitutions are undone.
  const candidates = [
    unleet(compact),
    stripEnds(unleet(compact)),
    unleet(stripEnds(compact)),
    compact.replaceAll(/[^a-z]/g, ""),
  ];
  if (
    candidates.some(
      (candidate) =>
        isCommonWord(candidate) ||
        (candidate.length > 0 &&
          (isSequence(candidate) || isRepetition(candidate))),
    )
  )
    return "too-common";
  return null;
};

/** One sentence a person can act on, for each problem. */
export const encryptionPasswordAdvice = (
  problem: EncryptionPasswordProblem,
): string =>
  problem === "too-short"
    ? `Use at least ${ENCRYPTION_PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong password you can remember.`
    : problem === "too-long"
      ? `Use at most ${ENCRYPTION_PASSWORD_MAX_LENGTH} characters.`
      : problem === "too-simple"
        ? "That password is a repeated, sequential or all-number pattern. Choose something less predictable."
        : "That password is built on a very common word. Choose something less predictable, such as a few unrelated words.";
