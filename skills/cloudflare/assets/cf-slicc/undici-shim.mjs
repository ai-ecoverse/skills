// undici's fetch API over the runtime's global fetch (ai-ecoverse/slicc-jsh#1270).
export const fetch = (...a) => globalThis.fetch(...a);
export const Headers = globalThis.Headers;
export const Response = globalThis.Response;
export const Request = globalThis.Request;
export const FormData = globalThis.FormData;
export default { fetch, Headers, Response, Request, FormData };
