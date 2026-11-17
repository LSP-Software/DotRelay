// PROTOTYPE. A minimal screen model for the prototype recordings. It handles
// only what kit.ts emits: text, newlines, 24-bit SGR colour, bold, and
// "cursor up n lines, clear to end" (CSI n F, CSI 0 J). Shared by
// record.ts (snapshots) and the gallery page (playback).

const createScreen = () => {
  let lines = [""];
  let row = 0;
  const feed = (data) => {
    const parts = data.split(/(\x1b\[[0-9;?]*[A-Za-z]|\n)/);
    for (const part of parts) {
      if (part === "") continue;
      if (part === "\n") {
        row += 1;
        if (lines[row] === undefined) lines[row] = "";
        continue;
      }
      const up = /^\x1b\[(\d+)F$/.exec(part);
      if (up) {
        row = Math.max(0, row - Number(up[1]));
        continue;
      }
      if (part === "\x1b[0J") {
        lines.length = row + 1;
        lines[row] = "";
        continue;
      }
      if (/^\x1b\[\?/.test(part)) continue;
      lines[row] = (lines[row] ?? "") + part;
    }
  };
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lineHtml = (line) => {
    let out = "";
    let color = null;
    let bold = false;
    const open = () => {
      const style = [
        color ? `color:rgb(${color})` : "",
        bold ? "font-weight:700" : "",
      ]
        .filter(Boolean)
        .join(";");
      return style ? `<span style="${style}">` : "<span>";
    };
    let span = false;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      if (part === "") continue;
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (sgr) {
        const codes = sgr[1].split(";");
        if (codes[0] === "38" && codes[1] === "2")
          color = codes.slice(2, 5).join(",");
        else if (codes[0] === "39") color = null;
        else if (codes[0] === "1") bold = true;
        else if (codes[0] === "22") bold = false;
        else if (codes[0] === "0" || codes[0] === "") {
          color = null;
          bold = false;
        }
        if (span) out += "</span>";
        out += open();
        span = true;
        continue;
      }
      if (!span) {
        out += open();
        span = true;
      }
      out += esc(part);
    }
    if (span) out += "</span>";
    return out;
  };
  const html = () => lines.map(lineHtml).join("\n");
  const reset = () => {
    lines = [""];
    row = 0;
  };
  return { feed, html, reset, rows: () => lines.length };
};

if (typeof module !== "undefined") module.exports = { createScreen };
