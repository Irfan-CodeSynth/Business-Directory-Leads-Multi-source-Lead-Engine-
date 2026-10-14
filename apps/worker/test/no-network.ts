/**
 * The suite must never reach the internet: `npm test` runs offline, against injected
 * transports. Anything that forgets to inject one fails here instead of quietly
 * spending real requests on a live site.
 */
const blocked: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : String((input as Request).url ?? input);
  throw new Error(`test attempted a real network call to ${url}; inject a fetchPage/fetch instead`);
};

globalThis.fetch = blocked;
