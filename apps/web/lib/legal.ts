// Facts the Privacy policy and Terms of service depend on. Keep them here so
// a change of address, contact or provider is made once and both documents
// stay consistent.
export const legal = {
  company: "LSP SOFTWARE LTD",
  companyNumber: "TODO-COMPANY-NUMBER",
  registeredOffice: "TODO-REGISTERED-OFFICE",
  jurisdiction: "England and Wales",
  contactEmail: "TODO-CONTACT-EMAIL",
  effectiveDate: "TODO-EFFECTIVE-DATE",
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
    name: "TODO-HOSTING-PROVIDER",
    purpose: "Servers that run DotRelay and hold its database",
    location: "TODO-HOSTING-LOCATION",
  },
  {
    name: "Cloudflare, Inc.",
    purpose: "DNS, TLS and network protection in front of the service",
    location: "Global network",
  },
  {
    name: "TODO-BACKUP-PROVIDER",
    purpose: "Encrypted database backups",
    location: "TODO-BACKUP-LOCATION",
  },
];
