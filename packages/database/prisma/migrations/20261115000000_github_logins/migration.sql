-- The GitHub login last seen for a GitHub user id, recorded at sign-in from
-- the verified GitHub profile. Display data for finding a Member by login;
-- never a trust anchor.
CREATE TABLE "github_logins" (
    "githubSubject" VARCHAR(255) NOT NULL,
    "login" VARCHAR(39) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "github_logins_pkey" PRIMARY KEY ("githubSubject")
);
