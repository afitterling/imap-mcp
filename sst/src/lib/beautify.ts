/**
 * Turn the plain text a model writes into a mail that looks composed rather than
 * dumped. Models reach for markdown and ASCII alignment; both read badly in a mail
 * client, so we render a proper HTML part and keep the text part as the fallback.
 *
 * Deliberately a small markdown subset — mail clients strip <style>, so every rule
 * is inline, and anything exotic is more likely to break than to help.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Inline spans: **bold**, *italic*, `code`, bare URLs and mail addresses. */
function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#f3f3f1;padding:1px 4px;border-radius:3px">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\bhttps?:\/\/[^\s<>")]+/g, (u) => `<a href="${u}" style="color:#c2552d">${u}</a>`);
  out = out.replace(/\b([\w.+-]+@[\w-]+\.[\w.]+)\b/g, '<a href="mailto:$1" style="color:#c2552d">$1</a>');
  return out;
}

type Block = { kind: string; lines: string[] };

/** Group the text into blocks before rendering, so lists and tables stay together. */
function group(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const push = () => { if (current) blocks.push(current); current = null; };

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const kind =
      line.trim() === "" ? "blank"
      : /^\s*[-*]\s+/.test(line) ? "ul"
      : /^\s*\d+[.)]\s+/.test(line) ? "ol"
      : /^\|.*\|$/.test(line.trim()) ? "table"
      : /^\s{2,}\S/.test(line) ? "pre"          // an indented column layout
      : /^(#{1,3})\s+/.test(line) ? "h"
      : /^[-=_]{3,}$/.test(line.trim()) ? "hr"
      : /^[A-Z0-9][A-Z0-9 ,.'&/()-]{6,}$/.test(line.trim()) ? "h"  // A SHOUTED HEADING
      : "p";

    if (kind === "blank") { push(); continue; }
    if (kind === "hr") { push(); blocks.push({ kind: "hr", lines: [] }); continue; }
    if (!current || current.kind !== kind || kind === "h") { push(); current = { kind, lines: [] }; }
    current.lines.push(line);
  }
  push();
  return blocks;
}

function renderTable(lines: string[]): string {
  const rows = lines
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  const th = head
    .map((c) => `<th style="text-align:left;padding:7px 12px;border-bottom:2px solid #e3e3df;font-size:13px;color:#6b6b66;font-weight:600">${inline(c)}</th>`)
    .join("");
  const tb = body
    .map((cells, i) => {
      const bg = i % 2 ? "background:#faf9f7;" : "";
      const tds = cells
        .map((c) => `<td style="${bg}padding:7px 12px;border-bottom:1px solid #eeede9;font-size:14px">${inline(c)}</td>`)
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:14px 0">
<thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

/** Detect a trailing signature so it can be set apart from the body. */
function splitSignature(text: string): [string, string | null] {
  const marker = text.lastIndexOf("\n-- \n");
  if (marker !== -1) return [text.slice(0, marker), text.slice(marker + 5)];
  return [text, null];
}

export function beautify(text: string): string {
  const [bodyText, signature] = splitSignature(text);
  const html = group(bodyText)
    .map((b) => {
      const joined = b.lines.join("\n");
      switch (b.kind) {
        case "h": {
          const clean = b.lines[0].replace(/^#{1,3}\s+/, "");
          return `<h2 style="font:600 15px/1.4 ${FONT};margin:22px 0 8px;color:#1a1a18">${inline(clean)}</h2>`;
        }
        case "ul":
        case "ol": {
          const tag = b.kind;
          const items = b.lines
            .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))
            .map((l) => `<li style="margin:4px 0">${inline(l)}</li>`)
            .join("");
          return `<${tag} style="margin:10px 0;padding-left:22px;font:14px/1.6 ${FONT};color:#1a1a18">${items}</${tag}>`;
        }
        case "table":
          return renderTable(b.lines);
        case "pre":
          // Column-aligned text only survives in a monospace box.
          return `<pre style="font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;background:#f7f6f4;border:1px solid #eeede9;border-radius:6px;padding:12px 14px;margin:12px 0;white-space:pre-wrap;color:#1a1a18">${esc(joined)}</pre>`;
        case "hr":
          return `<hr style="border:0;border-top:1px solid #e3e3df;margin:22px 0">`;
        default:
          return `<p style="font:14px/1.65 ${FONT};margin:10px 0;color:#1a1a18">${inline(joined).replace(/\n/g, "<br>")}</p>`;
      }
    })
    .join("\n");

  const sig = signature
    ? `<div style="margin-top:26px;padding-top:14px;border-top:1px solid #e3e3df;font:13px/1.55 ${FONT};color:#6b6b66">${inline(signature).replace(/\n/g, "<br>")}</div>`
    : "";

  return `<div style="max-width:640px;margin:0;padding:0;font:14px/1.65 ${FONT};color:#1a1a18">
${html}
${sig}
</div>`;
}
