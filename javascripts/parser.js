const name = /^[A-Za-z_][A-Za-z0-9_]*$/;
const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const operators = new Set([";", "&&", "||", "|", "<", ">", ">>"]);
const redirects = new Set(["<", ">", ">>", "0<", "1>", "1>>", "2>", "2>>"]);

const expand = (source, index, env) => {
  const next = source[index + 1];
  if (next === "?") return [String(env["?"] ?? 0), index + 2];
  if (next === "{") {
    const end = source.indexOf("}", index + 2);
    if (end < 0) throw new SyntaxError("missing } in variable expansion");
    const key = source.slice(index + 2, end);
    if (!name.test(key)) throw new SyntaxError(`invalid variable name: ${key}`);
    return [String(env[key] ?? ""), end + 1];
  }
  const match = source.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match ? [String(env[match[0]] ?? ""), index + match[0].length + 1] : ["$", index + 1];
};

const append = (parts, text, expandable) => {
  if (!text) return;
  if (parts.at(-1)?.expandable === expandable) parts.at(-1).text += text;
  else parts.push({ text, expandable });
};

const raw = (word) => word.parts.map(({ text }) => text).join("");

export const completionStart = (source) => {
  let index = source.length;
  while (index && source[index - 1].trim() && !";|&".includes(source[index - 1])) index--;
  return index;
};

export const expandWord = (word, env = {}) =>
  word.parts
    .map(({ text, expandable }) => {
      if (!expandable) return text;
      let value = "";
      for (let i = 0; i < text.length; ) {
        if (text[i] !== "$") {
          value += text[i++];
          continue;
        }
        const [expanded, next] = expand(text, i, env);
        value += expanded;
        i = next;
      }
      return value;
    })
    .join("");

export const tokenize = (source, _env = {}, limits = {}) => {
  if (typeof source !== "string") throw new TypeError("command must be a string");
  if (source.length > (limits.maxSource ?? 16_384)) throw new RangeError("command is too long");
  const tokens = [];
  let word = [];
  let started = false;
  let quote = "";
  const pushWord = () => {
    if (!started) return;
    tokens.push({ type: "word", parts: word });
    word = [];
    started = false;
  };
  const pushOperator = (value) => {
    pushWord();
    if (value === ";" && (!tokens.length || tokens.at(-1).value === ";")) return;
    tokens.push({ type: "operator", value });
  };

  for (let i = 0; i < source.length; ) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = "";
      else append(word, char, false);
      started = true;
      i++;
      continue;
    }
    if (!quote && char === "'") {
      quote = "'";
      started = true;
      i++;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? "" : '"';
      started = true;
      i++;
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= source.length) throw new SyntaxError("trailing backslash");
      if (quote === '"' && !["$", '"', "\\", "\n"].includes(source[i + 1])) {
        append(word, char, true);
        started = true;
        i++;
        continue;
      }
      i++;
      if (source[i] !== "\n") {
        append(word, source[i], false);
        started = true;
      }
      i++;
      continue;
    }
    if (char === "$") {
      append(word, char, true);
      started = true;
      i++;
      continue;
    }
    if (!quote && char === "#" && !started) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      pushWord();
      if (char === "\n" && !["&&", "||", "|"].includes(tokens.at(-1)?.value)) pushOperator(";");
      i++;
      continue;
    }
    if (!quote) {
      if (!started && "012".includes(char) && ["<", ">"].includes(source[i + 1])) {
        const size = source.slice(i + 1, i + 3) === ">>" ? 3 : 2;
        const redirect = source.slice(i, i + size);
        if (!redirects.has(redirect)) throw new SyntaxError(`unsupported redirect: ${redirect}`);
        pushOperator(redirect);
        i += size;
        continue;
      }
      const pair = source.slice(i, i + 2);
      const operator = ["&&", "||", ">>"].includes(pair) ? pair : operators.has(char) ? char : "";
      if (operator) {
        pushOperator(operator);
        i += operator.length;
        continue;
      }
      if (char === "&") throw new SyntaxError("unsupported operator: &");
    }
    append(word, char, true);
    started = true;
    i++;
  }
  if (quote) throw new SyntaxError(`unterminated ${quote} quote`);
  pushWord();
  if (tokens.at(-1)?.value === ";") tokens.pop();
  if (tokens.length > (limits.maxTokens ?? 1024)) throw new RangeError("too many tokens");
  return tokens;
};

const command = (tokens, cursor, limits) => {
  const words = [];
  const redirections = [];
  while (cursor.i < tokens.length && ![";", "&&", "||", "|"].includes(tokens[cursor.i].value)) {
    const token = tokens[cursor.i++];
    if (redirects.has(token.value) && token.type === "operator") {
      const target = tokens[cursor.i++];
      if (target?.type !== "word") throw new SyntaxError(`missing target after ${token.value}`);
      redirections.push({ type: token.value, path: target });
    } else if (token.type === "word") words.push(token);
    else throw new SyntaxError(`unexpected operator: ${token.value}`);
  }
  if (words.length > (limits.maxArgs ?? 128)) throw new RangeError("too many arguments");
  const assignments = [];
  while (words.length) {
    const match = raw(words[0]).match(assignment);
    if (!match) break;
    assignments.push([match[1], words.shift()]);
  }
  if (!words.length && !assignments.length && !redirections.length) throw new SyntaxError("empty command");
  return { argv: words, assignments, redirects: redirections };
};

export const parse = (source, env = {}, limits = {}) => {
  const tokens = tokenize(source, env, limits);
  const cursor = { i: 0 };
  const jobs = [];
  let link = null;
  let commands = 0;
  while (cursor.i < tokens.length) {
    const pipeline = [command(tokens, cursor, limits)];
    commands++;
    while (tokens[cursor.i]?.value === "|") {
      cursor.i++;
      if (cursor.i >= tokens.length) throw new SyntaxError("missing command after |");
      pipeline.push(command(tokens, cursor, limits));
      commands++;
    }
    jobs.push({ link, pipeline });
    const separator = tokens[cursor.i++];
    if (!separator) break;
    if (![";", "&&", "||"].includes(separator.value)) {
      throw new SyntaxError(`unexpected operator: ${separator.value}`);
    }
    link = separator.value;
    if (cursor.i >= tokens.length && link !== ";") throw new SyntaxError(`missing command after ${link}`);
    while (tokens[cursor.i]?.value === ";") cursor.i++;
  }
  if (commands > (limits.maxCommands ?? 128)) throw new RangeError("too many commands");
  if (jobs.length > (limits.maxPipelines ?? 64)) throw new RangeError("too many pipelines");
  return jobs;
};
