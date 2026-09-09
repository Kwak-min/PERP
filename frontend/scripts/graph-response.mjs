// Subscribe before navigation and drain the first completed request, not a headers-only
// response that StrictMode cleanup can still abort before its body exists.
export function graphResponseBody(page, predicate) {
  return page.waitForEvent('requestfinished', { predicate }).then(async request => {
    const response = await request.response();
    return { status: response.status(), body: await response.json() };
  });
}
