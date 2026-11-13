import ProtectedDashboard from "../components/protected-dashboard";

export default function UserDashboardPage() {
  return <ProtectedDashboard role="TEACHER" />;
}
