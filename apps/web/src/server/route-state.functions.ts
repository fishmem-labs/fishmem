import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { auth } from "@/lib/auth";
import { emailConfigured } from "@/lib/auth-shared";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { getAppDb } from "@/lib/platform";
import { requiresFirstUserSetup } from "@/lib/server/bootstrap-policy";
import { findInviteByToken, inviteUsable } from "@/lib/server/invites";

export const getLoginState = createServerFn({ method: "GET" }).handler(
  async () => {
    if (await requiresFirstUserSetup()) throw redirect({ to: "/setup" });
    if ((await auth())?.user) throw redirect({ to: "/dashboard" });
    return {
      magicLinkEnabled: emailConfigured(await getRuntimeEnv()),
    };
  },
);

export const getSetupState = createServerFn({ method: "GET" }).handler(
  async () => {
    if (!(await requiresFirstUserSetup())) throw redirect({ to: "/login" });
    return { freshInstall: true };
  },
);

export const requireDashboardSession = createServerFn({
  method: "GET",
}).handler(async () => {
  const session = await auth();
  if (!session?.user) {
    throw redirect({
      to: "/login",
      search: { callbackUrl: "/dashboard" },
    });
  }
  return session;
});

export const getInviteState = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const env = await getRuntimeEnv();
    const invite = await findInviteByToken(await getAppDb(env), data.token);
    return {
      email:
        invite?.email && inviteUsable(invite) ? invite.email : null,
    };
  });
