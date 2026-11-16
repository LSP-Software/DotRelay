// Plain transactional email bodies. Subjects and headings are fixed text:
// Team names and display names are chosen by Members, and mail from
// DotRelay's domain should not carry their words where a reader trusts it
// most. Bodies say only what the recipient needs to act, and name no
// repository: a repository's name is resolved with someone's GitHub access
// and may be private to them. The few user-controlled strings left pass
// through `clean` for text and `escapeHtml` for HTML. No images, tracking
// pixels or remote resources.

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

// The Team and the inviter are shown after the recipient signs in, where
// the name is attributed to the Team instead of to DotRelay's mail.
export const renderInvitationEmail = (
  input: Readonly<{
    readonly expiresAt: Date;
    readonly acceptUrl: string;
    readonly supportAddress: string;
  }>,
): RenderedEmail =>
  render({
    subject: "You're invited to a Team on DotRelay",
    heading: "You're invited to a Team on DotRelay",
    paragraphs: [
      "A Team owner or admin invited your GitHub account to a Team on DotRelay.",
      `Sign in with GitHub to see the Team and accept or decline. The invitation expires on ${formatDate(input.expiresAt)}.`,
    ],
    action: { label: "Review the invitation", url: input.acceptUrl },
    reason: "someone invited your GitHub account to a DotRelay Team",
    supportAddress: input.supportAddress,
  });

export const renderKeysSharedEmail = (
  input: Readonly<{
    readonly projectCount: number;
    readonly workspaceUrl: string;
    readonly supportAddress: string;
  }>,
): RenderedEmail =>
  render({
    subject: "Your DotRelay Project keys are ready",
    heading: "You can now pull",
    paragraphs: [
      `The keys for ${input.projectCount === 1 ? "one Project" : `${input.projectCount} Projects`} in one of your DotRelay Teams were shared with your Devices.`,
      "In the repository, run:",
      { code: "dotrelay pull" },
    ],
    action: { label: "Open DotRelay", url: input.workspaceUrl },
    reason: "you are a Member of a DotRelay Team",
    supportAddress: input.supportAddress,
  });

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const renderInvitationAcceptedEmail = (
  input: Readonly<{
    readonly memberUserId: string;
    // The cached GitHub login (github_logins), when one is recorded.
    readonly memberLogin?: string | null;
    readonly teamId: string;
    readonly membersUrl: string;
    readonly supportAddress: string;
  }>,
): RenderedEmail => {
  // A login is friendlier than a User id, but only a well-formed one goes
  // into a command line.
  const shareKeysTarget =
    input.memberLogin && GITHUB_LOGIN.test(input.memberLogin)
      ? input.memberLogin
      : input.memberUserId;
  return render({
    subject: "A new Member is waiting for Project keys on DotRelay",
    heading: "A new Member is waiting for Project keys",
    paragraphs: [
      "Someone accepted an invitation to a Team you own or administer on DotRelay. They can't pull until an owner or admin shares the Project keys with them, after comparing their account fingerprint.",
      "Use Share project keys in the Members view, or run:",
      {
        code: `dotrelay team share-keys ${shareKeysTarget} --team ${input.teamId}`,
      },
    ],
    action: { label: "Open the Members view", url: input.membersUrl },
    reason: "you are an owner or admin of a DotRelay Team",
    supportAddress: input.supportAddress,
  });
};
