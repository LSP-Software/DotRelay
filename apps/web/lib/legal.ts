// Facts the Privacy policy and Terms of service depend on. Keep them here so
// a change of address, contact or provider is made once and both documents
// stay consistent.
export const legal = {
  company: "LSP SOFTWARE LTD",
  companyNumber: "14566565",
  registeredOffice:
    "Unit 82a James Carter Road, Mildenhall, Bury St. Edmunds, England, IP28 7DE",
  jurisdiction: "England and Wales",
  contactEmail: "support@dotrelay.dev",
  effectiveDate: "15 November 2026",
  service: "the hosted DotRelay service at dotrelay.dev",
} as const;

// Organisations that process personal data for the hosted service. Update
// this list, and the policy's effective date, before adding a provider.
export const subprocessors: readonly Readonly<{
  readonly name: string;
  readonly purpose: string;
  readonly location: string;
}>[] = [
  {
    name: "GitHub, Inc.",
    purpose:
      "Sign-in, and looking up repositories and accounts on your behalf through the DotRelay GitHub App",
    location: "United States",
  },
  {
    name: "Hetzner Online GmbH",
    purpose: "Servers that run DotRelay and hold its database",
    location: "Finland",
  },
  {
    name: "Cloudflare, Inc.",
    purpose: "DNS, TLS and network protection in front of the service",
    location: "Global network",
  },
  {
    name: "Backblaze, Inc.",
    purpose: "Database backups",
    location: "United States (US East)",
  },
];
