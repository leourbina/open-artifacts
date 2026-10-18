import { AUTH } from "@oa/shared";
import { toast } from "@oa/ui";
import { api } from "../api/client";
import { useRedirect } from "./redirect";

/** POST logout, then go to /sign-in. On failure stay put and say so. */
export function useSignOut() {
  const redirect = useRedirect();
  return async () => {
    try {
      await api.send("POST", AUTH.logout, undefined);
    } catch {
      toast({
        title: "Couldn't sign out",
        description: "Try again.",
        tone: "danger",
      });
      return;
    }
    redirect("/sign-in");
  };
}
