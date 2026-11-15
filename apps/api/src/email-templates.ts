// Plain transactional email bodies. Every user-controlled string (Team names,
// display names, repository names) passes through `clean` for text and
// `escapeHtml` for HTML. No images, tracking pixels or remote resources.

export type RenderedEmail = Readonly<{
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}>;

type Paragraph = string | Readonly<{ readonly code: string }>;

type EmailContent = Readonly<{
  readonly subject: string;
  readonly heading: string;
  readonly paragraphs: readonly Paragraph[];
  readonly action: Readonly<{ readonly label: string; readonly url: string }>;
  readonly reason: string;
  readonly supportAddress: string;
}>;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** One line, no control characters, bounded length. */
export const clean = (value: string, maxLength = 100): string => {
  const line = value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
};

const formatDate = (value: Date): string =>
  `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value)} UTC`;

const listNames = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

const render = (content: EmailContent): RenderedEmail => {
  const footer = [
    `You received this because ${content.reason}.`,
    `Replies to this address aren't read. For help, email ${content.supportAddress}.`,
  ];
  const text = [
    content.heading,
    "",
    ...content.paragraphs.flatMap((paragraph) => [
      typeof paragraph === "string" ? paragraph : `  ${paragraph.code}`,
      "",
    ]),
    `${content.action.label}: ${content.action.url}`,
    "",
    "--",
    ...footer,
    "",
  ].join("\n");
  const paragraphStyle = "margin:0 0 16px;font-size:15px;line-height:1.5";
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(content.subject)}</title></head>`,
    "<body style=\"margin:0;padding:24px;background:#ffffff;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif\">",
    '<div style="max-width:560px;margin:0 auto">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map((paragraph) =>
      typeof paragraph === "string"
        ? `<p style="${paragraphStyle}">${escapeHtml(paragraph)}</p>`
        : `<p style="${paragraphStyle}"><code style="padding:2px 6px;background:#f3f4f6;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px">${escapeHtml(paragraph.code)}</code></p>`,
    ),
    `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:10px 16px;background:#1f2328;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px">${escapeHtml(content.action.label)}</a></p>`,
    `<p style="${paragraphStyle};color:#59636e;font-size:13px">Or open this link: ${escapeHtml(content.action.url)}</p>`,
    '<hr style="border:none;border-top:1px solid #d1d9e0;margin:24px 0">',
    ...footer.map(
      (line) =>
        `<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#59636e">${escapeHtml(line)}</p>`,
    ),
    "</div></body></html>",
  ].join("");
  return Object.freeze({ subject: content.subject, text, html });
};

export const renderInvitationEmail = (
  input: Readonly<{
    readonly teamName: string;
    readonly inviterName: string | null;
    readonly expiresAt: Date;
    readonly acceptUrl: string;
    readonly supportAddress: string;
  }>,
): RenderedEmail => {
  const teamName = clean(input.teamName);
  const inviter = input.inviterName ? clean(input.inviterName) : null;
  return render({
    subject: `You're invited to join ${teamName} on DotRelay`,
    heading: `Join ${teamName} on DotRelay`,
    paragraphs: [
      `${inviter ?? "A Team owner or admin"} invited you to join the Team ${teamName} on DotRelay.`,
      `Sign in with GitHub to accept or decline. The invitation expires on ${formatDate(input.expiresAt)}.`,
    ],
    action: { label: "Review the invitation", url: input.acceptUrl },
    reason: `someone invited your GitHub account to the DotRelay Team ${teamName}`,
    supportAddress: input.supportAddress,
  });
};

export const renderKeysSharedEmail = (
  input: Readonly<{
    readonly teamName: string;
    readonly projectNames: readonly string[];
    readonly workspaceUrl: string;
    readonly supportAddress: string;
  }>,
): RenderedEmail => {
  const teamName = clean(input.teamName);
  const projects = input.projectNames.map((name) => clean(name));
  const single = projects.length === 1;
  return render({
    subject: single
      ? `You can now pull ${projects[0]} with DotRelay`
      : `You can now pull ${teamName}'s Projects with DotRelay`,
    heading: "You can now pull",
    paragraphs: [
      `The Project keys for ${listNames(projects)} in the Team ${teamName} were shared with your Devices.`,
      "In the repository, run:",
      { code: "dotrelay pull" },
    ],
    action: { label: "Open DotRelay", url: input.workspaceUrl },
    reason: `you are a Member of the DotRelay Team ${teamName}`,
    supportAddress: input.supportAddress,
  });
};

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const renderInvitationAcceptedEmail = (
  input: Readonly<{
    readonly teamName: string;
    readonly memberName: string | null;
    readonly memberUserId: string;
    // The cached GitHub login (github_logins), when one is recorded.
    readonly memberLogin?: string | null;
    readonly teamId: string;
    readonly membersUrl: string;
    readonly supportAddress: string;
  }>,
): RenderedEmail => {
  const teamName = clean(input.teamName);
  const member = input.memberName ? clean(input.memberName) : "A new Member";
  // A login is friendlier than a User id, but only a well-formed one goes
  // into a command line.
  const shareKeysTarget =
    input.memberLogin && GITHUB_LOGIN.test(input.memberLogin)
      ? input.memberLogin
      : input.memberUserId;
  return render({
    subject: `${member} joined ${teamName} and is waiting for Project keys`,
    heading: `${member} joined ${teamName}`,
    paragraphs: [
      `${member} accepted the invitation to the Team ${teamName}. They can't pull until an owner or admin shares the Project keys with them.`,
      "Use Share project keys in the Members view, or run:",
      {
        code: `dotrelay team share-keys ${shareKeysTarget} --team ${input.teamId}`,
      },
    ],
    action: { label: "Open the Members view", url: input.membersUrl },
    reason: `you are an owner or admin of the DotRelay Team ${teamName}`,
    supportAddress: input.supportAddress,
  });
};
