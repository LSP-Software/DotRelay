export type TerminalIo = Readonly<{
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}>;

const leftovers = new WeakMap<NodeJS.ReadableStream, string>();

export const readTerminalLine = async (
  question: string,
  terminal?: TerminalIo,
): Promise<string> => {
  const input = terminal?.input ?? process.stdin;
  const output = terminal?.output ?? process.stderr;
  output.write(`${question}: `);

  let buffer = leftovers.get(input) ?? "";
  const lineBreak = (): string | null => {
    const index = buffer.indexOf("\n");
    if (index === -1) return null;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    leftovers.set(input, buffer);
    return line;
  };

  const immediate = lineBreak();
  if (immediate !== null) return immediate;

  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const line = lineBreak();
      if (line === null) return;
      cleanup();
      resolve(line);
    };
    const onEnd = () => {
      cleanup();
      const line = lineBreak();
      if (line !== null) {
        resolve(line);
        return;
      }
      if (buffer.length > 0) {
        const rest = buffer.replace(/\r$/, "");
        leftovers.set(input, "");
        resolve(rest);
        return;
      }
      reject(new Error("terminal input closed"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    if (
      typeof (input as NodeJS.ReadableStream & { resume?: () => void })
        .resume === "function"
    )
      (input as NodeJS.ReadableStream & { resume: () => void }).resume();
  });
};
