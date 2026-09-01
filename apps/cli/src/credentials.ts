import { CliError } from "./errors";

export type NativeCredentialStore = Readonly<{
  readonly get: (
    service: string,
    account: string,
  ) => Promise<Uint8Array | null>;
  readonly set: (
    service: string,
    account: string,
    secret: Uint8Array,
  ) => Promise<void>;
  readonly delete: (service: string, account: string) => Promise<void>;
}>;

const command = async (
  executable: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<Readonly<{ status: number; stdout: Uint8Array }>> => {
  try {
    const child = Bun.spawn([executable, ...args], {
      stdin: input ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const [stdout, status] = await Promise.all([
      new Response(child.stdout).bytes(),
      child.exited,
    ]);
    return { status, stdout };
  } catch {
    throw new CliError(
      "local-io",
      "the operating-system credential store is unavailable",
      {},
      "credential_store_unavailable",
    );
  }
};

const requireSupportedPlatform = (): "security" | "secret-tool" => {
  if (process.platform === "darwin") return "security";
  if (process.platform === "linux") return "secret-tool";
  throw new CliError(
    "local-io",
    "this platform has no supported secure credential-store integration",
    {},
    "credential_store_unsupported",
  );
};

export const createNativeCredentialStore = (): NativeCredentialStore => {
  const executable = requireSupportedPlatform();
  if (executable === "security") {
    return Object.freeze({
      get: async (service, account) => {
        const result = await command(executable, [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]);
        return result.status === 0 ? result.stdout : null;
      },
      set: async (service, account, secret) => {
        const result = await command(
          executable,
          ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
          secret,
        );
        if (result.status !== 0)
          throw new CliError(
            "local-io",
            "could not save a credential in the operating-system store",
            {},
            "credential_store_write_failed",
          );
      },
      delete: async (service, account) => {
        const result = await command(executable, [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          account,
        ]);
        if (result.status !== 0 && result.status !== 44)
          throw new CliError(
            "local-io",
            "could not remove a credential from the operating-system store",
            {},
            "credential_store_delete_failed",
          );
      },
    });
  }
  return Object.freeze({
    get: async (service, account) => {
      const result = await command(executable, [
        "lookup",
        "service",
        service,
        "account",
        account,
      ]);
      return result.status === 0 ? result.stdout : null;
    },
    set: async (service, account, secret) => {
      const result = await command(
        executable,
        [
          "store",
          "--label",
          "DotRelay",
          "service",
          service,
          "account",
          account,
        ],
        secret,
      );
      if (result.status !== 0)
        throw new CliError(
          "local-io",
          "could not save a credential in the operating-system store",
          {},
          "credential_store_write_failed",
        );
    },
    delete: async (service, account) => {
      const result = await command(executable, [
        "clear",
        "service",
        service,
        "account",
        account,
      ]);
      if (result.status !== 0)
        throw new CliError(
          "local-io",
          "could not remove a credential from the operating-system store",
          {},
          "credential_store_delete_failed",
        );
    },
  });
};
