const { ShellJS } = globalThis;
const root = document.querySelector("#shell");
const profile = document.querySelector("#profile");
const cpu = document.querySelector("#cpu");
let mounted;

const probe = () => {
  let status;
  const options = {
    onSyscall: ({ args }) => {
      status = args[0];
      return null;
    },
  };
  if (cpu.value === "x86") {
    const machine = ShellJS.createX86(options);
    machine.load(
      Uint8Array.from([0x48, 0xb8, 60, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 42, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05]),
    );
    machine.run();
  } else {
    const machine = ShellJS.createArm(options);
    machine.load(Uint8Array.from([0x40, 0x05, 0x80, 0xd2, 0xa8, 0x0b, 0x80, 0xd2, 0x01, 0x00, 0x00, 0xd4]));
    machine.run();
  }
  return `${cpu.options[cpu.selectedIndex].text}: guest exit ${status}\n`;
};

const boot = () => {
  mounted?.destroy();
  root.querySelector("output").replaceChildren();
  const shell = ShellJS.createShell({
    profile: profile.value,
    manuals: { base: "../manuals/" },
    commands: { cpu: probe },
  });
  mounted = ShellJS.mountShell(root, shell, { promptText: `${shell.env.USER}@${shell.env.HOSTNAME} # ` });
  root.querySelector("input").focus();
};

profile.addEventListener("change", boot);
cpu.addEventListener("change", boot);
boot();
