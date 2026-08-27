"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { targetDiscoveryPolicyFromForm } from "@/services/music-discovery/target-discovery-form";

const CONFIG_PATH = "/dashboard/configuracao/destinos";

function valueOrNull(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" ? value : null;
}

export async function saveTargetDiscoveryPolicy(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId) redirect(`${CONFIG_PATH}?error=invalid`);

  let data;
  try {
    data = targetDiscoveryPolicyFromForm({
      discoveryEnabled: valueOrNull(formData.get("discoveryEnabled")),
      discoveryFamiliarEnabled: valueOrNull(
        formData.get("discoveryFamiliarEnabled"),
      ),
      discoveryRediscoveryEnabled: valueOrNull(
        formData.get("discoveryRediscoveryEnabled"),
      ),
      discoveryNoveltyEnabled: valueOrNull(
        formData.get("discoveryNoveltyEnabled"),
      ),
      discoveryReleasesEnabled: valueOrNull(
        formData.get("discoveryReleasesEnabled"),
      ),
      discoveryIntensity: valueOrNull(formData.get("discoveryIntensity")),
    });
  } catch {
    redirect(`${CONFIG_PATH}?error=discovery`);
  }

  const result = await prisma.targetPlaylist.updateMany({
    where: {
      id: targetId,
      userId: session.user.id,
    },
    data,
  });

  if (result.count !== 1) redirect(`${CONFIG_PATH}?error=invalid`);

  revalidatePath(CONFIG_PATH);
  redirect(`${CONFIG_PATH}?saved=updated`);
}
