-- AES-GCM ciphertext is plaintext || 16-byte tag. Empty Variable values are valid,
-- so ciphertextLength may equal 16. Persistence validation already allows >= 16.
ALTER TABLE "lane_objects"
  DROP CONSTRAINT "lane_objects_length_check",
  ADD CONSTRAINT "lane_objects_length_check"
  CHECK ("plaintextLength" >= 0 AND "ciphertextLength" >= 16 AND "ciphertextLength" <= 67108864);

ALTER TABLE "lane_commitment_objects"
  DROP CONSTRAINT "lane_commitment_objects_length_check",
  ADD CONSTRAINT "lane_commitment_objects_length_check"
  CHECK ("ciphertextLength" >= 16 AND "ciphertextLength" <= 67108864);

ALTER TABLE "revision_lane_commitments"
  DROP CONSTRAINT "revision_lane_commitments_length_check",
  ADD CONSTRAINT "revision_lane_commitments_length_check"
  CHECK ("ciphertextLength" >= 16 AND "ciphertextLength" <= 67108864);
