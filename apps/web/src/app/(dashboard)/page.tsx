import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { getApifyBudget, getDashboardStats } from "@/lib/queries";
import DashboardOverview from "@/components/DashboardOverview";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const uid = currentUserId();
  if (!uid) redirect("/login");

  const [stats, apify] = await Promise.all([getDashboardStats(), getApifyBudget()]);

  return <DashboardOverview stats={stats} apify={apify} />;
}
