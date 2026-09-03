import { createServer } from "node:net";
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
): Promise<
  Readonly<{ status: number; stdout: Uint8Array; stderr: Uint8Array }>
> => {
  try {
    const child = Bun.spawn([executable, ...args], {
      stdin: input ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input && child.stdin) {
      await child.stdin.write(input);
      await child.stdin.flush();
      child.stdin.end();
    }
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
      child.exited,
    ]);
    return { status, stdout, stderr };
  } catch {
    throw new CliError(
      "local-io",
      "the operating-system credential store is unavailable",
      {},
      "credential_store_unavailable",
    );
  }
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const standardBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const textCredentialPrefix = "dotrelay-v1:";

const decodeTextCredential = (value: Uint8Array): Uint8Array => {
  const text = new TextDecoder().decode(value).trimEnd();
  if (!text.startsWith(textCredentialPrefix)) return value;
  try {
    const binary = atob(text.slice(textCredentialPrefix.length));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CliError(
      "local-io",
      "the operating-system credential store returned an invalid credential",
      {},
      "credential_store_invalid",
    );
  }
};

const decodeStandardBase64 = (value: Uint8Array): Uint8Array => {
  try {
    const binary = atob(new TextDecoder().decode(value).trim());
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CliError(
      "local-io",
      "the operating-system credential store returned an invalid credential",
      {},
      "credential_store_invalid",
    );
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const commandStderr = (value: Uint8Array): string =>
  new TextDecoder().decode(value).trim().slice(0, 500);

const commandDiagnostic = (result: {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}): string =>
  [commandStderr(result.stderr), commandStderr(result.stdout)]
    .filter((value) => value.length > 0)
    .join(" | ");

const windowsInputPortMarker = "__DOTRELAY_INPUT_PORT__";
const windowsDpapiScope =
  process.env.GITHUB_ACTIONS === "true" ? "LocalMachine" : "CurrentUser";

const runWindowsCommand = async (script: string, input?: Uint8Array) => {
  if (!input)
    return command("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
  const server = createServer((socket) => {
    socket.write(Buffer.from(input), () => socket.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new CliError(
      "local-io",
      "the operating-system credential store is unavailable",
      {},
      "credential_store_unavailable",
    );
  }
  try {
    return await command("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script.replaceAll(windowsInputPortMarker, String(address.port)),
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const interactiveCredentialCommand = async (
  args: readonly string[],
  secret: Uint8Array,
): Promise<number> => {
  if (process.platform !== "darwin")
    throw new CliError(
      "local-io",
      "interactive credential-store access is unavailable",
      {},
      "credential_store_unavailable",
    );
  const commandLine = ["security", ...args].map(shellQuote).join(" ");
  const expectScript = [
    "set timeout 15",
    "set secret [string trim [read stdin]]",
    `spawn sh -c {${commandLine}}`,
    "expect {",
    '  *password*new*item:* { send -- "$secret\\r"; exp_continue }',
    '  *retype*password*new*item:* { send -- "$secret\\r"; exp_continue }',
    "  eof {}",
    "  timeout { exit 124 }",
    "}",
    "set result [wait]",
    "exit [lindex $result 3]",
  ].join("\n");
  try {
    const child = Bun.spawn(["expect", "-c", expectScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!child.stdin)
      throw new CliError(
        "local-io",
        "the operating-system credential store is unavailable",
        {},
        "credential_store_unavailable",
      );
    await child.stdin.write(secret);
    await child.stdin.flush();
    child.stdin.end();
    await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
    ]);
    return await child.exited;
  } catch (error) {
    if (error instanceof CliError) throw error;
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

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const windowsLegacyTarget = (service: string, account: string): string =>
  `DotRelay/${base64(new TextEncoder().encode(`${service}\0${account}`))}`;

const windowsTarget = async (
  service: string,
  account: string,
): Promise<string> =>
  `DotRelay/v2/${base64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${service}\0${account}`),
      ),
    ),
  )}`;

const WINDOWS_CREDENTIAL_TYPE = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class DotRelayCredential {",
  "[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {",
  "public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }",
  '[DllImport("advapi32.dll", EntryPoint="CredReadW", SetLastError=true)] public static extern bool CredRead(IntPtr target, uint type, uint flags, out IntPtr credential);',
  '[DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);',
  '[DllImport("advapi32.dll", EntryPoint="CredDeleteW", SetLastError=true)] public static extern bool CredDelete(IntPtr target, uint type, uint flags);',
  '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);',
  "public static byte[] Read(string target) { var targetPointer = Marshal.StringToCoTaskMemUni(target); try { IntPtr pointer; if (!CredRead(targetPointer, 1, 0, out pointer)) return null; var value = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL)); var bytes = new byte[value.CredentialBlobSize]; Marshal.Copy(value.CredentialBlob, bytes, 0, (int)value.CredentialBlobSize); CredFree(pointer); return bytes; } finally { Marshal.FreeCoTaskMem(targetPointer); } }",
  "public static bool Write(string target, byte[] bytes) { var targetPointer = Marshal.StringToCoTaskMemUni(target); var blobPointer = Marshal.AllocHGlobal(bytes.Length); try { Marshal.Copy(bytes, 0, blobPointer, bytes.Length); var value = new CREDENTIAL { Type=1, TargetName=targetPointer, CredentialBlob=blobPointer, CredentialBlobSize=(uint)bytes.Length, Persist=2 }; if (CredWrite(ref value, 0) && Read(target) != null) return true; value.Persist=1; return CredWrite(ref value, 0); } finally { Marshal.FreeHGlobal(blobPointer); Marshal.FreeCoTaskMem(targetPointer); } }",
  "}",
  "'@",
].join("\n");

const windowsScript = (
  operation: "read" | "write" | "delete",
  target: string,
): string =>
  [
    WINDOWS_CREDENTIAL_TYPE,
    `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${btoa(target)}'))`,
    `$operation = '${operation}'`,
    operation === "write"
      ? `$client = [Net.Sockets.TcpClient]::new('127.0.0.1', ${windowsInputPortMarker}); $stream = $client.GetStream(); $inputText = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII).ReadToEnd(); $client.Dispose()`
      : "$inputText = ''",
    "Add-Type -AssemblyName System.Security",
    "if ($operation -eq 'read') { $secret = [DotRelayCredential]::Read($target); if ($null -eq $secret) { exit 1 }; $encoded = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($secret)); [Console]::OpenStandardOutput().Write($encoded, 0, $encoded.Length); exit 0 }",
    "if ($operation -eq 'write') { $secret = [Convert]::FromBase64String($inputText); if (![DotRelayCredential]::Write($target, $secret)) { exit 1 }; exit 0 }",
    "$targetPointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($target); try { if (![DotRelayCredential]::CredDelete($targetPointer, 1, 0)) { exit 1 }; exit 0 } finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($targetPointer) }",
  ].join("\n");

const windowsDpapiScript = (
  operation: "read" | "write" | "delete",
  target: string,
): string =>
  [
    `$key = '${target.replaceAll("/", "_")}'`,
    "$root = Join-Path $env:LOCALAPPDATA 'DotRelay\\credentials'",
    "$path = Join-Path $root ($key + '.bin')",
    `$operation = '${operation}'`,
    operation === "write"
      ? `$client = [Net.Sockets.TcpClient]::new('127.0.0.1', ${windowsInputPortMarker}); $stream = $client.GetStream(); $inputText = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII).ReadToEnd(); $client.Dispose()`
      : "$inputText = ''",
    "Add-Type -AssemblyName System.Security",
    `if ($operation -eq 'read') { if (![IO.File]::Exists($path)) { exit 1 }; $protected = [IO.File]::ReadAllBytes($path); $secret = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::${windowsDpapiScope}); $encoded = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($secret)); [Console]::OpenStandardOutput().Write($encoded, 0, $encoded.Length); exit 0 }`,
    `if ($operation -eq 'write') { if ($inputText.Length -eq 0) { [Console]::Error.WriteLine('credential input was empty'); exit 2 }; [IO.Directory]::CreateDirectory($root) | Out-Null; $secret = [Convert]::FromBase64String($inputText); $protected = [System.Security.Cryptography.ProtectedData]::Protect($secret, $null, [System.Security.Cryptography.DataProtectionScope]::${windowsDpapiScope}); [IO.File]::WriteAllBytes($path, $protected); exit 0 }`,
    "if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }; exit 0",
  ].join("\n");

const createWindowsCredentialStore = (): NativeCredentialStore =>
  Object.freeze({
    get: async (service, account) => {
      const target = await windowsTarget(service, account);
      let result = await runWindowsCommand(windowsScript("read", target));
      if (result.status !== 0) {
        result = await runWindowsCommand(
          windowsScript("read", windowsLegacyTarget(service, account)),
        );
      }
      if (result.status === 0) return decodeStandardBase64(result.stdout);
      result = await runWindowsCommand(windowsDpapiScript("read", target));
      return result.status === 0 ? decodeStandardBase64(result.stdout) : null;
    },
    set: async (service, account, secret) => {
      const target = await windowsTarget(service, account);
      const input = new TextEncoder().encode(base64(secret));
      const nativeResult = await runWindowsCommand(
        windowsScript("write", target),
        input,
      );
      let nativeVerified = false;
      if (nativeResult.status === 0) {
        const verification = await runWindowsCommand(
          windowsScript("read", target),
        );
        if (verification.status === 0) {
          const stored = decodeStandardBase64(verification.stdout);
          nativeVerified = sameBytes(stored, secret);
        }
      }
      const dpapiResult = await runWindowsCommand(
        windowsDpapiScript("write", target),
        input,
      );
      let dpapiVerificationDetail = "read failed";
      if (dpapiResult.status === 0) {
        const verification = await runWindowsCommand(
          windowsDpapiScript("read", target),
        );
        if (verification.status === 0) {
          const stored = decodeStandardBase64(verification.stdout);
          if (sameBytes(stored, secret)) return;
          dpapiVerificationDetail = `returned ${stored.length} bytes for ${secret.length}-byte secret`;
        } else
          dpapiVerificationDetail =
            commandDiagnostic(verification) ||
            `read exited with code ${verification.status}`;
      } else if (commandStderr(dpapiResult.stderr)) {
        dpapiVerificationDetail = commandStderr(dpapiResult.stderr);
      }
      if (nativeVerified) return;
      throw new CliError(
        "local-io",
        `could not save a credential in the operating-system store: DPAPI ${dpapiVerificationDetail}`,
        {},
        "credential_store_write_failed",
      );
    },
    delete: async (service, account) => {
      const target = await windowsTarget(service, account);
      const targets = [target, windowsLegacyTarget(service, account)];
      const results = await Promise.all(
        targets.map((target) =>
          runWindowsCommand(windowsScript("delete", target)),
        ),
      );
      const dpapiResult = await runWindowsCommand(
        windowsDpapiScript("delete", target),
      );
      const failed = results.find(
        (result) => result.status !== 0 && result.status !== 1168,
      );
      if (failed || dpapiResult.status !== 0)
        throw new CliError(
          "local-io",
          "could not remove a credential from the operating-system store",
          {},
          "credential_store_delete_failed",
        );
    },
  });

export const createNativeCredentialStore = (): NativeCredentialStore => {
  if (process.platform === "win32") return createWindowsCredentialStore();
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
        return result.status === 0 ? decodeTextCredential(result.stdout) : null;
      },
      set: async (service, account, secret) => {
        // macOS security has no password-stdin mode. Its final -w prompts on
        // a controlling TTY, so answer that prompt without putting the secret
        // in process arguments or shell history. Encode the bytes first so
        // the line-oriented prompt cannot truncate binary credentials.
        const result = await interactiveCredentialCommand(
          [
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account,
            "-T",
            "/usr/bin/security",
            "-w",
          ],
          new TextEncoder().encode(
            `${textCredentialPrefix}${standardBase64(secret)}`,
          ),
        );
        if (result !== 0)
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
      return result.status === 0 ? decodeTextCredential(result.stdout) : null;
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
        new TextEncoder().encode(
          `${textCredentialPrefix}${standardBase64(secret)}`,
        ),
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
