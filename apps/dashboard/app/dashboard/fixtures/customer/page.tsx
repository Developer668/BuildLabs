import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CustomerWorkspace } from "../../../../components/customer-workspace";
import {
  CUSTOMER_FIXTURE_PROJECT_ID,
  customerEventFixtures,
  customerFixtureSnapshot,
} from "../../../../lib/fixtures";
import { dashboardFixturesEnabled } from "../../../../lib/fixture-mode";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Customer workspace fixture",
};

export default function CustomerFixturePage() {
  if (!dashboardFixturesEnabled()) {
    notFound();
  }
  const snapshot = customerFixtureSnapshot({
    aggregateRevision: 28,
    eventCursor: 52,
    lifecycle: {
      canonical: "verifying",
      label: "Proving this version",
      changedAt: "2026-07-24T16:19:11.000Z",
    },
    updatedAt: "2026-07-24T16:19:11.000Z",
  });
  return (
    <CustomerWorkspace
      fixture
      initialEvents={customerEventFixtures}
      initialSnapshot={snapshot}
      projectAlias={CUSTOMER_FIXTURE_PROJECT_ID}
    />
  );
}
