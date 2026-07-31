import { completionStart } from "./parser.js";

const element = (root, selector) => (root.matches?.(selector) ? root : root.querySelector(selector));

export const mountShell = (root, shell, options = {}) => {
  if (!root || typeof root.querySelector !== "function" || !shell?.exec) {
    throw new TypeError("mountShell requires a root element and shell");
  }
  const form = element(root, options.form ?? "form");
  const input = element(root, options.input ?? "input");
  const output = element(root, options.output ?? "output, [role=log]");
  const prompt = element(root, options.promptElement ?? "[data-shell-prompt]");
  if (!form || !input || !output) throw new TypeError("shell UI requires form, input, and output elements");
  const limit = options.maxEntries ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("maxEntries must be a positive integer");
  const history = [];
  let cursor = 0;
  let active;
  const render =
    options.render ??
    ((entry) => {
      const line = root.ownerDocument.createElement("pre");
      line.textContent = `${entry.prompt}${entry.command}\n${entry.stdout}${entry.stderr}`;
      output.append(line);
      output.scrollTop = output.scrollHeight;
    });
  const label = () => {
    const value = typeof options.prompt === "function" ? options.prompt(shell) : (options.promptText ?? "$ ");
    if (prompt) prompt.textContent = value;
    return value;
  };
  const submit = async (event) => {
    event.preventDefault();
    if (active) return;
    const command = input.value;
    if (!command.trim()) return;
    history.push(command);
    if (history.length > limit) history.shift();
    cursor = history.length;
    input.value = "";
    const shown = label();
    const readonly = input.readOnly;
    active = new AbortController();
    input.readOnly = true;
    try {
      const result = await shell.exec(command, { signal: active.signal });
      if (command.trim() === "clear") output.replaceChildren();
      else render({ ...result, command, prompt: shown }, { root, form, input, output, shell });
      while (output.childNodes.length > limit) output.firstChild.remove();
    } finally {
      active = null;
      input.readOnly = readonly;
      label();
      input.focus();
    }
  };
  const keydown = (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "c" && active) {
      event.preventDefault();
      active.abort();
    } else if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      output.replaceChildren();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.max(0, Math.min(history.length, cursor + (event.key === "ArrowUp" ? -1 : 1)));
      input.value = history[cursor] ?? "";
    } else if (event.key === "Tab") {
      const matches = shell.complete(input.value);
      if (matches.length === 1) {
        event.preventDefault();
        input.value = `${input.value.slice(0, completionStart(input.value))}${matches[0]}`;
      }
    }
  };
  form.addEventListener("submit", submit);
  input.addEventListener("keydown", keydown);
  label();
  return Object.freeze({
    destroy() {
      active?.abort();
      form.removeEventListener("submit", submit);
      input.removeEventListener("keydown", keydown);
    },
    focus: () => input.focus(),
  });
};
