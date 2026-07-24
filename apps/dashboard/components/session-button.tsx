"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

export function SessionButton({
  csrfCookie,
  endpoint,
  label = "Sign out",
  method = "DELETE",
  redirectTo,
}: {
  csrfCookie?: string | undefined;
  endpoint: string;
  label?: string;
  method?: "DELETE" | "POST";
  redirectTo: string;
}) {
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      const csrf = csrfCookie ? readCookie(csrfCookie) : undefined;
      const response = await fetch(endpoint, {
        method,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(csrf ? { "x-buildlabs-csrf": csrf } : {}),
        },
      });
      if (!response.ok) return;
      window.location.assign(redirectTo);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      aria-label={label}
      className="icon-button"
      data-tooltip={label}
      disabled={pending}
      onClick={() => void signOut()}
      type="button"
    >
      <LogOut aria-hidden="true" />
    </button>
  );
}

function readCookie(name: string): string | undefined {
  const matches = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1
    ? decodeURIComponent(matches[0]!.slice(name.length + 1))
    : undefined;
}
