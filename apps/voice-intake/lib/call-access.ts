function secret() {
  return process.env.CALL_LAB_ACCESS_CODE?.trim() || "";
}

export function callLabAuthorized(request: Request) {
  const expected = secret();
  if (!expected) return process.env.NODE_ENV !== "production";
  const supplied = request.headers.get("x-call-lab-key")?.trim() || "";
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}

export function unauthorizedResponse() {
  return Response.json(
    { error: "Enter the Call Lab access code." },
    {
      status: 401,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
