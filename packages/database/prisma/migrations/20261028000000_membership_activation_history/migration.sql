-- Re-activating a revived Membership appends a new activation row instead of
-- reusing the first one, so membershipId is history, not a unique owner.

DROP INDEX "membership_activation_objects_membershipId_key";

CREATE INDEX "membership_activation_objects_membershipId_idx" ON "membership_activation_objects"("membershipId");
