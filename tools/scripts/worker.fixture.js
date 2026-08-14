importScripts("/javascripts/shell.min.js");

(async () => {
  try {
    const shell = ShellJS.createShell({ wasm: "/wasm/shell.wasm" });
    postMessage({ ready: await shell.prepare("wasm") });
  } catch (error) {
    postMessage({ error: error.message, ready: false });
  }
})();
