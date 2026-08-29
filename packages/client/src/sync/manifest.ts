import {
  type ProtocolObject,
  parseProtocolObject,
  validateManifestCeilings,
} from "@dotrelay/contracts";

export type ManifestCounts = Readonly<{
  readonly variables: number;
  readonly laneCommitments: number;
}>;

export const manifestCountsFromDescriptor = (
  descriptor: ProtocolObject,
): ManifestCounts => {
  if (descriptor.get(1) !== 15)
    throw new TypeError("expected manifest descriptor");
  const laneCommitments = descriptor.get(53);
  const variables = Array.isArray(laneCommitments) ? laneCommitments.length : 0;
  return Object.freeze({
    variables,
    laneCommitments: variables,
  });
};

export const validateManifestDescriptor = (
  descriptorBytes: Uint8Array,
): ManifestCounts => {
  const descriptor = parseProtocolObject(descriptorBytes);
  const counts = manifestCountsFromDescriptor(descriptor);
  validateManifestCeilings(counts);
  return counts;
};

export const validateRevisionManifest = (
  revision: ProtocolObject,
): ManifestCounts => {
  if (revision.get(1) !== 16)
    throw new TypeError("expected revision protocol object");
  const descriptorBytes = revision.get(51);
  if (!(descriptorBytes instanceof Uint8Array))
    throw new TypeError("revision manifest descriptor is missing");
  return validateManifestDescriptor(descriptorBytes);
};
