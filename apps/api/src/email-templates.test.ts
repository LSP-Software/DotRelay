import { expect, test } from "bun:test";
import {
  clean,
  escapeHtml,
  renderInvitationAcceptedEmail,
  renderInvitationEmail,
  renderKeysSharedEmail,
} from "./email-templates";

const hostile = `<script>alert("x")</script> & 'Co'`;
const support = "support@dotrelay.dev";

const all = () => [
  renderInvitationEmail({
    teamName: hostile,
    inviterName: hostile,
    expiresAt: new Date("2026-11-22T10:30:00Z"),
    acceptUrl: "https://dotrelay.dev/workspace",
    supportAddress: support,
  }),
  renderKeysSharedEmail({
    teamName: hostile,
    projectNames: [hostile, "octo/api"],
    workspaceUrl: "https://dotrelay.dev/workspace?team=t&x=1",
    supportAddress: support,
  }),
  renderInvitationAcceptedEmail({
    teamName: hostile,
    memberName: hostile,
    memberUserId: "66666666-6666-4666-8666-666666666666",
    teamId: "11111111-1111-4111-8111-111111111111",
    membersUrl: "https://dotrelay.dev/workspace?team=t&view=team",
    supportAddress: support,
  }),
];

test("user-controlled strings are escaped in HTML", () => {
  for (const email of all()) {
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)");
    expect(email.html).toContain("&amp; &#39;Co&#39;");
    expect(email.html).toContain("&amp;");
  }
  expect(all()[1]?.html).toContain(
    'href="https://dotrelay.dev/workspace?team=t&amp;x=1"',
  );
});

test("emails carry no images or remote resources and explain why they were sent", () => {
  for (const email of all()) {
    expect(email.html).not.toMatch(/<img|<link|<script|url\(|src=/i);
    expect(email.text).toContain("You received this because");
    expect(email.text).toContain(support);
    expect(email.html).toContain("You received this because");
    expect(email.html).toContain(support);
    expect(email.subject).not.toMatch(/[\r\n]/);
  }
});

test("each email says what to do next", () => {
  const [invitation, shared, accepted] = all();
  expect(invitation?.text).toContain("expires on 22 November 2026");
  expect(invitation?.text).toContain("https://dotrelay.dev/workspace");
  expect(shared?.text).toContain("dotrelay pull");
  expect(shared?.text).toContain("octo/api");
  expect(accepted?.text).toContain("Share project keys");
  expect(accepted?.text).toContain(
    "dotrelay team share-keys 66666666-6666-4666-8666-666666666666 --team 11111111-1111-4111-8111-111111111111",
  );
  expect(
    renderInvitationEmail({
      teamName: "Ops",
      inviterName: null,
      expiresAt: new Date(),
      acceptUrl: "https://dotrelay.dev/workspace",
      supportAddress: support,
    }).text,
  ).toContain("A Team owner or admin invited you");
});

test("names are folded onto one bounded line", () => {
  expect(clean("Ops\r\nBcc: x\u2028y")).toBe("Ops Bcc: x y");
  expect(clean("a".repeat(150))).toHaveLength(100);
  expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
});
