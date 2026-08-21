-- Better Auth records are deliberately isolated from DotRelay domain identities.
CREATE TABLE "auth_users" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "image" VARCHAR(2048),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "auth_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_sessions" (
  "id" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "token" VARCHAR(512) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "ipAddress" VARCHAR(255),
  "userAgent" VARCHAR(1024),
  "userId" TEXT NOT NULL,
  CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_accounts" (
  "id" TEXT NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "providerId" VARCHAR(255) NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ(3),
  "refreshTokenExpiresAt" TIMESTAMPTZ(3),
  "scope" VARCHAR(2048),
  "password" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "issuer" VARCHAR(2048) NOT NULL DEFAULT '',
  CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_verifications" (
  "id" TEXT NOT NULL,
  "identifier" VARCHAR(512) NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "auth_verifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_device_codes" (
  "id" TEXT NOT NULL,
  "deviceCode" VARCHAR(255) NOT NULL,
  "userCode" VARCHAR(64) NOT NULL,
  "userId" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "lastPolledAt" TIMESTAMPTZ(3),
  "pollingInterval" INTEGER,
  "clientId" VARCHAR(255),
  "scope" VARCHAR(2048),
  CONSTRAINT "auth_device_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_users_email_key" ON "auth_users"("email");
CREATE UNIQUE INDEX "auth_sessions_token_key" ON "auth_sessions"("token");
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");
CREATE UNIQUE INDEX "auth_accounts_issuer_accountId_key" ON "auth_accounts"("issuer", "accountId");
CREATE INDEX "auth_accounts_userId_idx" ON "auth_accounts"("userId");
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications"("identifier");
CREATE UNIQUE INDEX "auth_device_codes_deviceCode_key" ON "auth_device_codes"("deviceCode");
CREATE UNIQUE INDEX "auth_device_codes_userCode_key" ON "auth_device_codes"("userCode");

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auth_accounts"
  ADD CONSTRAINT "auth_accounts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
