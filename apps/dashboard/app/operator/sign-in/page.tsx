import type { Metadata } from "next";

import { OperatorSignIn } from "../../../components/operator-sign-in";

export const metadata: Metadata = {
  title: "Operator sign in",
};

export default function OperatorSignInPage() {
  return <OperatorSignIn />;
}
