import ProtectedDashboard from "../../components/protected-dashboard";

export default function QuestionSettingsPage() {
  return <ProtectedDashboard role="TEACHER" view="question-settings" />;
}
