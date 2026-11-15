import type { Metadata } from "next";
import { legal, subprocessors } from "@/lib/legal";
import { LegalDocument } from "../legal-document";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What DotRelay can and cannot see, what it stores, and your rights.",
};

const PrivacyPage = () => (
  <LegalDocument title="Privacy policy">
    <p>
      This policy explains what personal data {legal.company} collects when you
      use {legal.service}, why, and what rights you have. DotRelay is
      pre-release software: features and this policy may change, and we will
      update the effective date when they do.
    </p>

    <h2>Who we are</h2>
    <p>
      {legal.company} (company number {legal.companyNumber}, registered office{" "}
      {legal.registeredOffice}) is the data controller for the hosted service.
      Contact us at{" "}
      <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>.
    </p>
    <p>
      If you use a DotRelay server that someone else runs (a self-hosted
      instance), that operator controls your data there, and this policy does
      not apply to it.
    </p>

    <h2>What we cannot see</h2>
    <p>
      Your devices encrypt your variables before they leave them. We store only
      the encrypted result and never receive the keys to open it. That covers
      variable names, values and descriptions. Your encryption password,
      recovery code and passkey secrets never leave your devices. If you lose
      every device and your recovery code, we cannot recover your data for you.
    </p>
    <p>
      DotRelay uses classical (not post-quantum) cryptography. Anyone you share
      a project with can read its values and keep copies, and removing them
      later does not erase what they already have.
    </p>

    <h2>What we collect</h2>
    <ul>
      <li>
        <strong>Your GitHub account:</strong> your numeric GitHub user ID,
        username, display name, email address and avatar URL, received when you
        sign in.
      </li>
      <li>
        <strong>GitHub access tokens:</strong> the tokens issued to the DotRelay
        GitHub App on your behalf, stored encrypted. We use them only to look up
        repositories and accounts you ask DotRelay to link or invite. They are
        never sent to your devices.
      </li>
      <li>
        <strong>Sessions:</strong> sign-in sessions, with the IP address and
        browser or CLI user agent that created them.
      </li>
      <li>
        <strong>Teams and projects:</strong> team names, memberships, roles,
        invitations, the GitHub repositories linked to projects, and environment
        labels such as &ldquo;production&rdquo;. These are not end-to-end
        encrypted.
      </li>
      <li>
        <strong>Devices:</strong> each device&apos;s public keys and its display
        details (name, operating system and client type).
      </li>
      <li>
        <strong>Encrypted data and its metadata:</strong> the encrypted
        variables, keys and history, plus who published each change, from which
        device, when, and how large it was. We keep a record of administrative
        actions such as invitations, removals and device revocations.
      </li>
      <li>
        <strong>Security logs:</strong> IP address, endpoint, response status
        and transfer size for requests, used to detect abuse.
      </li>
    </ul>
    <p>
      We do not use analytics, advertising or tracking cookies, and we do not
      sell personal data.
    </p>

    <h2>Why we use it</h2>
    <ul>
      <li>
        To provide the service you signed up for: signing you in, syncing your
        encrypted data, and managing teams and devices (performance of our
        contract with you).
      </li>
      <li>
        To email you about your account and your teams, such as invitations,
        notices that project keys were shared with you, and notices to team
        owners and admins when someone joins (performance of our contract with
        you).
      </li>
      <li>
        Where you have agreed, or where the law otherwise allows, to send you
        news and offers about DotRelay. You can opt out at any time using the
        link in each email.
      </li>
      <li>
        To keep the service secure: rate limits, abuse detection and
        investigating incidents (our legitimate interest in protecting the
        service and its users).
      </li>
      <li>To meet legal obligations where they apply.</li>
    </ul>

    <h2>Cookies and local storage</h2>
    <p>
      We set one essential cookie, which keeps you signed in. The web app stores
      this browser&apos;s device keys and settings in your browser (IndexedDB
      and local storage); that data stays on your machine. The CLI stores its
      keys and session in its local configuration directory.
    </p>

    <h2>Who we share it with</h2>
    <p>
      We use these providers to run the hosted service. They process data only
      on our instructions.
    </p>
    <table>
      <caption className="sr-only">Hosted service providers</caption>
      <thead>
        <tr>
          <th>Provider</th>
          <th>Purpose</th>
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        {subprocessors.map((provider) => (
          <tr key={provider.name}>
            <td>{provider.name}</td>
            <td>{provider.purpose}</td>
            <td>{provider.location}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p>
      Where data is transferred outside the UK, we rely on the safeguards UK
      data protection law provides for such transfers, such as adequacy
      regulations or standard contractual clauses. We may also disclose data
      when the law requires it.
    </p>

    <h2>How long we keep it</h2>
    <ul>
      <li>Security logs: 30 days.</li>
      <li>Diagnostic logs, which never contain your values: 14 days.</li>
      <li>
        Sessions: until you sign out, or at most 30 days after last use and 90
        days after sign-in.
      </li>
      <li>
        Expired sign-in codes, device enrollments and invitations: deleted
        automatically after they expire.
      </li>
      <li>
        Account, team and encrypted data: while your account exists. A
        project&apos;s signed history is kept so every member can verify it,
        including changes made by people who have since left.
      </li>
      <li>
        Database backups follow our backup provider&apos;s rotation and are
        overwritten over time.
      </li>
    </ul>

    <h2>Your rights</h2>
    <p>
      Under UK data protection law you can ask to access, correct or delete your
      personal data, to restrict or object to how we use it, and to receive it
      in a portable form. Email{" "}
      <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a> and we
      will respond within one month. Deleting your account removes your account
      data; some records, such as signed history in projects other members still
      use, may be kept in a form that no longer identifies you where we can, or
      for as long as that project exists.
    </p>
    <p>
      You can also complain to the Information Commissioner&apos;s Office (
      <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk</a>), though we
      would appreciate the chance to help first.
    </p>

    <h2>Children</h2>
    <p>DotRelay is not intended for anyone under 16.</p>

    <h2>Changes</h2>
    <p>
      We will update this page and its effective date when this policy changes,
      and tell signed-in users about significant changes.
    </p>
  </LegalDocument>
);

export default PrivacyPage;
