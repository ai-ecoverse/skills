// SLICC: route undici's fetch API to the runtime's global fetch (undici 7/8 over
// TLS exits the process mid-body in slicc-jsh). Only these names are imported by cf's deps.
export const fetch = (...a) => globalThis.fetch(...a);
export const Headers = globalThis.Headers;
export const Response = globalThis.Response;
export const Request = globalThis.Request;
export const FormData = globalThis.FormData;
export default { fetch, Headers, Response, Request, FormData };
