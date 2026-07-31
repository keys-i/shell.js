const frozen = (value) =>
  Object.freeze({
    ...value,
    messages: Object.freeze([...(value.messages ?? [])]),
    modules: Object.freeze([...(value.modules ?? [])]),
    sysctls: Object.freeze({ ...(value.sysctls ?? {}) }),
  });

const profile = (name, sysname, release, machine, extra = {}) =>
  frozen({
    name,
    sysname,
    release,
    machine,
    hostname: "shell",
    user: "guest",
    group: "guest",
    uid: 1000,
    gid: 1000,
    home: "/home/guest",
    shell: "/bin/sh",
    path: "/bin:/usr/bin",
    messages: [],
    modules: [],
    sysctls: {},
    ...extra,
  });

export const profiles = Object.freeze({
  posix: profile("posix", "POSIX", "1", "wasm32"),
  freebsd: profile("freebsd", "FreeBSD", "14.2-RELEASE", "amd64", {
    hostname: "recv",
    user: "rad",
    group: "wheel",
    uid: 0,
    gid: 0,
    home: "/home/rad",
    ostype: "freebsd14.2",
    modules: ["kernel", "zfs.ko"],
    messages: ["FreeBSD 14.2-RELEASE", "Trying to mount root from ufs:/dev/ada0p2"],
    sysctls: {
      "kern.hostname": "recv",
      "kern.osrelease": "14.2-RELEASE",
      "kern.ostype": "FreeBSD",
    },
  }),
  linux: profile("linux", "Linux", "6.12.0-web", "wasm32", {
    ostype: "linux-gnu",
    modules: ["loop", "overlay"],
    messages: ["Linux version 6.12.0-web", "VFS: Mounted root (tmpfs filesystem) readonly"],
    sysctls: {
      "kernel.hostname": "shell",
      "kernel.osrelease": "6.12.0-web",
      "kernel.ostype": "Linux",
    },
  }),
});

export const resolveProfile = (value = "posix") => {
  if (typeof value === "string") {
    if (!profiles[value]) throw new TypeError(`unknown profile: ${value}`);
    return profiles[value];
  }
  if (!value || typeof value !== "object") throw new TypeError("profile must be a name or object");
  return frozen({ ...profiles.posix, ...value });
};
