// PROTOTYPE. Fake data shared by every direction so they compare like for like.

export const D = {
  origin: "api.dotrelay.dev",
  serverId: "srv_4f9c2a7e1b",
  user: "maya",
  device: "maya-laptop",
  repo: "acme/api",
  team: "Acme",
  envs: [
    { label: "development", detail: "14 values" },
    { label: "staging", detail: "16 values" },
    { label: "production", detail: "19 values" },
  ],
  env: "development",
  userCode: "WDJB-MJHT",
  verifyUrl: "https://api.dotrelay.dev/device?code=WDJB-MJHT",
  transferCode: "tr_8KD2M4QX.7F3A91C2",
  fingerprint: "7F3A 91C2",
  revision: 14,
  pulled: { total: 14, team: 11, mine: 3, changed: 3 },
  push: [
    { name: "STRIPE_SECRET_KEY", kind: "changed", owner: "Team" },
    { name: "FEATURE_NEW_CHECKOUT", kind: "added", owner: null },
    { name: "LEGACY_REDIS_URL", kind: "removed", owner: "Team" },
  ] as const,
};

export const SCENES = [
  { id: "first-run", title: "First run, zero to .env" },
  { id: "signed-out", title: "pull while signed out" },
  { id: "push", title: "push with preview" },
  { id: "status", title: "status" },
  { id: "failure", title: "Network drops mid-pull" },
  { id: "ci", title: "Scripts and CI (no prompts)" },
] as const;

export type SceneId = (typeof SCENES)[number]["id"];
