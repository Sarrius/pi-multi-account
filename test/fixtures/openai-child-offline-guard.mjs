// A fresh native child is deliberately extension-free and can dispatch only to this machine.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error(`OFFLINE_CHILD_REFUSES_EXTERNAL_ROUTE: ${url.origin}`);
  return nativeFetch(input, init);
};
