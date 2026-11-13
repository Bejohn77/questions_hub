import ProtectedDashboard from "../components/protected-dashboard";

export default function AdminDashboardPage() {
  return <ProtectedDashboard role="ADMIN" />;
}
