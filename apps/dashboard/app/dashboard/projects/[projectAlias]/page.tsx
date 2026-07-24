import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CustomerWorkspace } from "../../../../components/customer-workspace";

type PageProps = {
  params: Promise<{ projectAlias: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Project workspace",
};

export default async function CustomerProjectPage({ params }: PageProps) {
  const { projectAlias } = await params;
  if (!/^prj_[A-Za-z0-9_-]{22}$/.test(projectAlias)) {
    notFound();
  }
  return <CustomerWorkspace fixture={false} projectAlias={projectAlias} />;
}
