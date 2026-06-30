"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await fetch("/api/logout", { method: "POST" });
          router.replace("/login");
          router.refresh();
        })
      }
      className="text-sm font-medium text-slate-500 transition hover:text-slate-800 disabled:opacity-60"
    >
      Sign out
    </button>
  );
}
