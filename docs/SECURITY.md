# Security

Supported releases receive fixes on the latest major line. Report a
vulnerability privately with impact, reproduction steps, and affected
versions; do not open a public issue before a fix is available.

shell.js executes registered JavaScript handlers inside its host page. It is
not a security boundary for hostile handlers. The built-in engine does not use
`eval`, host processes, the host filesystem, or implicit network commands.
Applications must still enforce Content Security Policy, isolate untrusted
Wasm, cap custom command work, and treat rendered output as text.
