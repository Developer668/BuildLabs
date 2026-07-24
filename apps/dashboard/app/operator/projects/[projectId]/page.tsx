import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { OperatorLiveProject } from "../../../../components/operator-live";
import {
  OPERATOR_SESSION_COOKIE,
  verifyOperatorSession,
} from "../../../../lib/operator-auth";

export const dynamic = "force-dynamic";

export default async function OperatorProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const cookieStore = await cookies();
  const session = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value;
  if (!verifyOperatorSession(session)) {
    redirect("/operator/sign-in");
  }

  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) {
    notFound();
  }

  return <OperatorLiveProject projectId={projectId} />;
}
