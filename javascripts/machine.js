export const createV86 = ({ V86, onSerial = () => {}, ...options } = {}) => {
  if (typeof V86 !== "function") throw new TypeError("V86 must be a constructor");
  if (typeof onSerial !== "function") throw new TypeError("onSerial must be a function");
  const emulator = new V86({ ...options, autostart: false });
  for (const method of ["add_listener", "remove_listener", "run", "stop", "destroy", "serial0_send"]) {
    if (typeof emulator?.[method] !== "function") throw new TypeError("incompatible V86 constructor");
  }
  const output = (byte) => onSerial(byte);
  emulator.add_listener("serial0-output-byte", output);
  let destroyed = false;
  let teardown;
  const live = () => {
    if (destroyed) throw new Error("V86 instance is destroyed");
    if (teardown) throw new Error("V86 instance is being destroyed");
    return emulator;
  };

  return Object.freeze({
    emulator,
    destroy() {
      if (destroyed) return;
      teardown ??= (async () => {
        let removed = false;
        try {
          emulator.remove_listener("serial0-output-byte", output);
          removed = true;
          await emulator.destroy();
          destroyed = true;
        } catch (error) {
          if (removed) emulator.add_listener("serial0-output-byte", output);
          teardown = undefined;
          throw error;
        }
      })();
      return teardown;
    },
    run: () => live().run(),
    stop: () => live().stop(),
    write(value) {
      if (typeof value !== "string") throw new TypeError("serial input must be a string");
      live().serial0_send(value);
    },
  });
};
