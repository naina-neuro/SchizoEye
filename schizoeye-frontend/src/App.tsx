import { ClinicianDashboard } from './pages/ClinicianDashboard.tsx';
import { AdminDashboard } from './pages/AdminDashboard.tsx';
import { DoctorDashboard } from './pages/DoctorDashboard.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { useAuth } from './hooks/useAuth.ts';

/**
 * Role → dashboard, as in the original showRoleDashboard(). This is navigation, not security:
 * the role comes from localStorage and Flask does not yet enforce roles (see the Stage-1 auth findings).
 */
export default function App() {
  const { user, signIn, signOut } = useAuth();
  if (!user) return <LoginPage onLogin={signIn} />;
  const out = () => void signOut();
  switch (user.role) {
    case 'doctor': return <DoctorDashboard user={user} onSignOut={out} />;
    case 'admin': return <AdminDashboard user={user} onSignOut={out} />;
    case 'clinician': return <ClinicianDashboard user={user} onSignOut={out} />;
    default:
      return (
        <div className="dash-root"><div className="dash-launch"><div className="dash-launch-inner">
          <h2 className="dash-launch-title">Unknown role</h2>
          <p className="dash-launch-text">{`The account role "${user.role}" has no dashboard.`}</p>
          <button className="dash-btn primary" onClick={out}>Sign Out</button>
        </div></div></div>
      );
  }
}
