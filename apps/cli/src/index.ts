export const version = "0.0.0-foundation";

export function renderHelp(): string {
  return [
    "dotrelay — DotRelay standalone CLI",
    "",
    "Usage: dotrelay [--help] [--version]",
  ].join("\n");
}

export function main(args: string[]): string {
  if (args.includes("--version")) return version;
  return renderHelp();
}

if (import.meta.main) {
  console.log(main(Bun.argv.slice(2)));
}
