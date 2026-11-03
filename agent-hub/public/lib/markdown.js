import { h } from "./dom.js";

// Safe Markdown subset renderer: builds DOM nodes directly (no innerHTML), so model output
// cannot inject markup. Supports headings, paragraphs, lists, task lists, code fences,
// block quotes, tables, rules, and inline code/bold/italic/links.

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function renderMarkdown(source) {
  const root = h("div", { class: "md" });
  appendBlocks(root, String(source ?? "").replace(/\r\n?/g, "\n").split("\n"));
  return root;
}

function isBlockStart(line) {
  return /^(\s*)(`{3,}|~{3,})/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
}

function appendBlocks(root, lines) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++;
      root.append(h("pre", { class: "code" }, h("code", { "data-lang": fence[2] || null }, body.join("\n"))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      root.append(h(`h${heading[1].length}`, {}, inline(heading[2])));
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.append(h("hr"));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      const quote = h("blockquote");
      appendBlocks(quote, quoted);
      root.append(quote);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      const head = h("tr", {}, cells(line).map((cell) => h("th", {}, inline(cell))));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(h("tr", {}, cells(lines[i]).map((cell) => h("td", {}, inline(cell)))));
        i++;
      }
      root.append(h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, head), h("tbody", {}, rows))));
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const list = h(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i]);
        if (!match) {
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) {
            list.lastChild.append(" ", ...inline(lines[i].trim()));
            i++;
            continue;
          }
          break;
        }
        const li = h("li", { class: match[1].length >= 2 ? "nested" : null });
        const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3]);
        if (task) li.append(h("input", { type: "checkbox", disabled: true, checked: task[1] !== " " }), " ", ...inline(task[2]));
        else li.append(...inline(match[3]));
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) paragraph.push(lines[i++]);
    root.append(h("p", {}, inline(paragraph.join(" "))));
  }
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inline(text) {
  const out = [];
  let last = 0;
  const source = String(text);
  for (const match of source.matchAll(INLINE)) {
    if (match.index > last) out.push(source.slice(last, match.index));
    if (match[2] !== undefined) out.push(h("code", {}, match[2]));
    else if (match[3] !== undefined || match[4] !== undefined) out.push(h("strong", {}, inline(match[3] ?? match[4])));
    else if (match[5] !== undefined) out.push(h("em", {}, inline(match[5])));
    else if (match[6] !== undefined) {
      const url = match[7];
      out.push(
        /^https?:\/\//i.test(url)
          ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, match[6])
          : h("span", { class: "md-link", title: url }, match[6]),
      );
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

/** Renders a unified git diff with per-file sections and line coloring. */
export function renderDiff(text) {
  const root = h("div", { class: "diff" });
  let file = null;
  const startFile = (title) => {
    file = h("div", { class: "diff-file" }, h("div", { class: "diff-file-header" }, title));
    root.append(file);
  };
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = / b\/(.+)$/.exec(line);
      startFile(match ? match[1] : line);
      continue;
    }
    if (!file) startFile("diff");
    if (/^(index |--- |\+\+\+ )/.test(line)) continue;
    if (/^(new file mode|deleted file mode|similarity index|rename from|rename to|Binary files)/.test(line)) {
      file.append(h("div", { class: "diff-line meta" }, line));
      continue;
    }
    const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    file.append(h("div", { class: `diff-line ${cls}` }, line || " "));
  }
  return root;
}
