importScripts("./shell.min.js");

(async () => {
  try {
    const shell = ShellJS.createShell({ wasm: true });
    postMessage({ ready: await shell.prepare("wasm") });
  } catch (error) {
    postMessage({ error: error.message, ready: false });
  }
})();
