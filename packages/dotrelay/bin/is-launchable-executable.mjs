import { open } from "node:fs/promises";

// Machine identifiers for the native executable formats the selector can
// verify, keyed by the Node architecture they launch on. Architectures whose
// machine number is ambiguous per Node arch (ppc64 covers both
// EM_PPC64=21 and EM_PPC64LE=23; Node reports s390x, not s390) are omitted
// so they fall through to the kernel's own launch attempt.
const elfMachineForArch = {
  x64: 62,
  ia32: 3,
  arm64: 183,
  arm: 40,
  riscv64: 243,
  mips: 8,
  mipsel: 8,
};
const machCpuTypeForArch = {
  x64: 0x01000007,
  ia32: 7,
  arm64: 0x0100000c,
  arm: 12,
};
const peMachineForArch = {
  x64: 0x8664,
  ia32: 0x014c,
  arm64: 0xaa64,
  arm: 0x01c0,
};

// Node re-executes a file the kernel cannot execute (ENOEXEC) through the
// system shell, which would turn a corrupted or wrong-architecture binary
// into opaque shell noise; Bun fails the spawn instead. Checking the
// executable's format and architecture before launching keeps both runtimes
// on the same report.
//
// A file passes when the kernel can exec it directly on this machine: a
// shebang wrapper, or a native executable whose format and architecture
// match this platform. A recognized foreign or damaged executable fails
// here so the selector can report the repair instead of an opaque spawn
// error; anything unrecognizable is left to the launch attempt.
export const isLaunchableExecutable = async (path) => {
  let head = null;
  try {
    const handle = await open(path);
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, 128, 0);
    await handle.close();
    head = buffer.subarray(0, bytesRead);
  } catch {
    return false;
  }
  if (head.length < 4) return false;
  const u16 = (offset, little) =>
    little
      ? head[offset] | (head[offset + 1] << 8)
      : ((head[offset] << 8) | head[offset + 1]) & 0xffff;
  // Normalized unsigned so magic values whose first byte is >= 0x80 compare
  // equal to their canonical constants.
  const u32 = (offset, little) =>
    (little
      ? head[offset] |
        (head[offset + 1] << 8) |
        (head[offset + 2] << 16) |
        (head[offset + 3] << 24)
      : (head[offset] << 24) |
        (head[offset + 1] << 16) |
        (head[offset + 2] << 8) |
        head[offset + 3]) >>> 0;
  // A shebang wrapper is executable by the kernel even though it is text.
  if (head[0] === 0x23 && head[1] === 0x21) return true;
  // ELF: the architecture is the e_machine field after the 16-byte header.
  if (
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    const expected = elfMachineForArch[process.arch];
    if (expected === undefined) return true;
    const machine = u16(18, head[5] === 1);
    return machine === expected;
  }
  // Mach-O: the on-disk magics appear in both endiannesses. 0xcf/0xce lead
  // the little-endian thin 64/32-bit magics (0xcffaedfe/0xcfaeedfe) that
  // modern macOS builds carry, 0xfe leads the big-endian spellings, and
  // 0xca/0xbe lead fat binaries, which stay accepted for the kernel to
  // arbitrate the slices.
  const first = head[0];
  const machLittleEndian = first === 0xcf || first === 0xce || first === 0xbe;
  const machMagic =
    first === 0xfe || first === 0xca || machLittleEndian
      ? u32(0, machLittleEndian)
      : 0;
  if (machMagic === 0xfeedface || machMagic === 0xfeedfacf) {
    const expected = machCpuTypeForArch[process.arch];
    if (expected === undefined) return true;
    // The CPU type follows the magic in the header's own byte order.
    return u32(4, machLittleEndian) === expected;
  }
  if (process.platform === "win32" && head[0] === 0x4d && head[1] === 0x5a) {
    const eLfanew = u32(0x3c, true);
    if (
      head.length > eLfanew + 6 &&
      head[eLfanew] === 0x50 &&
      head[eLfanew + 1] === 0x45
    ) {
      const expected = peMachineForArch[process.arch];
      if (expected === undefined) return true;
      return u16(eLfanew + 4, true) === expected;
    }
    // A PE file whose machine field could not be read is left to the
    // launch attempt.
    return true;
  }
  // A recognized native executable that the kernel could not match (for
  // example a fat or big-endian Mach-O) is left to the launch attempt.
  return machMagic !== 0;
};
