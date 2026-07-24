export const dynamic = "force-dynamic";

function configuredPhoneNumber() {
  const raw =
    process.env.PLIVO_PRIMARY_NUMBER?.trim() ||
    process.env.PLIVO_TEST_NUMBER?.trim() ||
    "";
  return /^\+[1-9]\d{7,14}$/.test(raw) ? raw : "";
}

function displayPhoneNumber(phone: string) {
  const us = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

export async function GET() {
  const phone = configuredPhoneNumber();
  return Response.json(
    {
      phoneDisplay: phone ? displayPhoneNumber(phone) : "Phone number not configured",
      phoneHref: phone ? `tel:${phone}` : "",
      accessRequired: Boolean(process.env.CALL_LAB_ACCESS_CODE?.trim()),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
