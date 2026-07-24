import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { OperatorLiveQueue } from "../../components/operator-live";
import { OperatorStudio } from "../../components/operator-studio";
import { operatorFixture } from "../../lib/operator-data";
import {
  OPERATOR_SESSION_COOKIE,
  verifyOperatorSession,
} from "../../lib/operator-auth";

export const dynamic = "force-dynamic";

export default async function OperatorPage() {
  const cookieStore = await cookies();
  const session = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value;
  if (!verifyOperatorSession(session)) {
    redirect("/operator/sign-in");
  }

  if (process.env.BUILDLABS_DASHBOARD_FIXTURES === "1") {
    return <OperatorStudio project={operatorFixture} />;
  }

  return <OperatorLiveQueue />;
}
