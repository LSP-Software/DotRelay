import type { Metadata } from "next";
import Link from "next/link";
import { legal } from "@/lib/legal";
import { LegalDocument } from "../legal-document";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms for using the hosted DotRelay service.",
};

const TermsPage = () => (
  <LegalDocument title="Terms of service">
    <p>
      These terms are an agreement between you and {legal.company} (company
      number {legal.companyNumber}, registered office {legal.registeredOffice})
      for your use of {legal.service}, its web app, API and the DotRelay CLI
      when connected to it. By signing in you accept them. If you use DotRelay
      for an organisation, you accept them on its behalf and confirm you are
      allowed to.
    </p>

    <h2>Pre-release service</h2>
    <p>
      DotRelay is in early access. Features may change or be removed, the
      service may be unavailable at times, and we do not yet offer an uptime
      commitment. Keep your own copy of anything you cannot afford to lose, and
      do not rely on DotRelay as your only store of a secret.
    </p>

    <h2>Price</h2>
    <p>
      The hosted service is free during early access. We plan to charge for it
      later. Before any paid plan applies to you, we will tell you the price and
      terms at least 30 days in advance, and we will not charge you without your
      agreement. If you do not want to pay, you can export your data and stop
      using the service.
    </p>

    <h2>Your account</h2>
    <ul>
      <li>You sign in with GitHub and must be at least 16.</li>
      <li>
        You are responsible for activity under your account and on your devices,
        and for keeping your encryption password, recovery code and devices
        safe.
      </li>
      <li>
        Your data is end-to-end encrypted. We cannot read it, and{" "}
        <strong>
          we cannot recover it if you lose every device and your recovery code
        </strong>
        .
      </li>
      <li>
        Removing someone from a team stops future access but cannot take back
        values they have already seen. Rotate keys and change those secrets when
        someone leaves.
      </li>
    </ul>

    <h2>Your content</h2>
    <p>
      You keep all rights to what you store in DotRelay. You give us permission
      to store, copy and transmit it, in encrypted form, only as needed to run
      the service for you and the people you share it with. You are responsible
      for having the right to store and share it.
    </p>

    <h2>Acceptable use</h2>
    <p>Do not use DotRelay to:</p>
    <ul>
      <li>break the law or infringe anyone&apos;s rights;</li>
      <li>
        attack, probe or overload the service, or get around its rate limits,
        authentication or access controls, except through authorised security
        research reported as our{" "}
        <a href="https://github.com/LSP-Software/DotRelay/security/policy">
          security policy
        </a>{" "}
        describes;
      </li>
      <li>store or distribute malware; or</li>
      <li>
        resell, rent or offer the hosted service to others as a service of your
        own.
      </li>
    </ul>

    <h2>The open-source software</h2>
    <p>
      DotRelay&apos;s source code is available under its own licence (AGPL-3.0
      with the Commons Clause), which governs your use of the code. These terms
      cover only the hosted service we run.
    </p>

    <h2>Suspension and ending</h2>
    <p>
      You can stop using DotRelay at any time and ask us to delete your account.
      We may suspend or close an account that breaks these terms or puts the
      service or other users at risk, and will tell you why unless the law or
      security prevents it. If we ever shut the hosted service down, we will
      give at least 30 days&apos; notice so you can export your data with the
      CLI.
    </p>

    <h2>Liability</h2>
    <p>
      The service is provided free of charge during early access, &ldquo;as
      is&rdquo; and &ldquo;as available&rdquo;. We do not promise that it will
      be uninterrupted, error-free or suitable for any particular purpose, and
      you use it at your own risk.
    </p>
    <p>
      To the fullest extent the law allows, we exclude all liability to you,
      whether in contract, negligence or otherwise, for any loss or damage
      arising from your use of, or inability to use, the service. That includes
      loss of data, secrets or credentials, loss of profits or business, and any
      indirect or consequential loss. If we are liable to you despite this, our
      total liability is limited to the greater of the amount you paid us in the
      12 months before the claim and £50.
    </p>
    <p>
      Nothing in these terms excludes or limits liability for death or personal
      injury caused by negligence, for fraud or fraudulent misrepresentation, or
      for anything else the law does not allow us to exclude or limit. If you
      are a consumer, these terms do not affect your statutory rights.
    </p>

    <h2>Changes to these terms</h2>
    <p>
      We may update these terms. We will give signed-in users notice of
      significant changes before they apply. If you keep using DotRelay after
      that, the new terms apply; if you do not agree, stop using the service.
    </p>

    <h2>Law and contact</h2>
    <p>
      These terms are governed by the law of {legal.jurisdiction}, whose courts
      have jurisdiction. If you live elsewhere in the UK, you may also bring a
      claim in your local courts. How we handle personal data is described in
      our <Link href="/privacy">privacy policy</Link>. Contact us at{" "}
      <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>.
    </p>
  </LegalDocument>
);

export default TermsPage;
