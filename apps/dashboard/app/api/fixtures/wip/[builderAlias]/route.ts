import sharp from "sharp";

import { dashboardFixturesEnabled } from "../../../../../lib/fixture-mode";

const FIXTURE_BUILDER = "bld_aaaaaaaaaaaaaaaaaaaaaa";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ builderAlias: string }> },
): Promise<Response> {
  const { builderAlias } = await context.params;
  if (!dashboardFixturesEnabled() || builderAlias !== FIXTURE_BUILDER) {
    return new Response(null, { status: 404 });
  }

  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
      <rect width="1280" height="800" fill="#edf1ee"/>
      <rect width="260" height="800" fill="#1f292d"/>
      <rect x="34" y="42" width="142" height="18" rx="3" fill="#65c5d0"/>
      <rect x="34" y="90" width="176" height="11" rx="2" fill="#687477"/>
      <rect x="34" y="122" width="148" height="11" rx="2" fill="#687477"/>
      <rect x="34" y="154" width="165" height="11" rx="2" fill="#687477"/>
      <text x="306" y="70" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#182024">NORTHSTAR APPOINTMENTS</text>
      <text x="306" y="105" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#182024">Schedule an appointment</text>
      <text x="306" y="140" font-family="Arial, sans-serif" font-size="16" fill="#617076">Choose a service before selecting an available time.</text>
      <rect x="306" y="190" width="260" height="126" rx="6" fill="#ffffff" stroke="#c3cbc6"/>
      <rect x="590" y="190" width="260" height="126" rx="6" fill="#ffffff" stroke="#50aebe" stroke-width="3"/>
      <rect x="874" y="190" width="260" height="126" rx="6" fill="#ffffff" stroke="#c3cbc6"/>
      <text x="330" y="230" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#263034">Consultation</text>
      <text x="614" y="230" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#263034">Follow-up</text>
      <text x="898" y="230" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#263034">Extended visit</text>
      <rect x="306" y="360" width="828" height="310" rx="6" fill="#ffffff" stroke="#c3cbc6"/>
      <text x="336" y="405" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#263034">Available times</text>
      <rect x="336" y="442" width="142" height="42" rx="5" fill="#e6f5f7" stroke="#50aebe"/>
      <rect x="496" y="442" width="142" height="42" rx="5" fill="#f5f7f5" stroke="#c3cbc6"/>
      <rect x="656" y="442" width="142" height="42" rx="5" fill="#f5f7f5" stroke="#c3cbc6"/>
      <rect x="816" y="442" width="142" height="42" rx="5" fill="#f5f7f5" stroke="#c3cbc6"/>
      <text x="370" y="469" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#176270">09:30</text>
      <text x="530" y="469" font-family="Arial, sans-serif" font-size="14" fill="#39464b">10:15</text>
      <text x="690" y="469" font-family="Arial, sans-serif" font-size="14" fill="#39464b">11:00</text>
      <text x="850" y="469" font-family="Arial, sans-serif" font-size="14" fill="#39464b">13:30</text>
      <rect x="336" y="532" width="770" height="1" fill="#d6ddd8"/>
      <rect x="336" y="570" width="270" height="58" rx="5" fill="#087f93"/>
      <text x="400" y="606" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff">Continue to details</text>
      <rect x="20" y="750" width="1240" height="34" rx="4" fill="#332616" stroke="#e7b35f"/>
      <text x="38" y="773" font-family="monospace" font-size="14" font-weight="700" fill="#ffd996">UNVERIFIED WIP · BUILDER 1 · CONTRACT V3 · FIXTURE CAPTURE</text>
    </svg>
  `);
  const png = await sharp(svg).png({ compressionLevel: 9 }).toBuffer();
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "image/png",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
