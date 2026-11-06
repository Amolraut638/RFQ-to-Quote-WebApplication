import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { RFQListPage } from './pages/RFQListPage';
import { RFQDetailPage } from './pages/RFQDetailPage';
import { ApprovalPage } from './pages/ApprovalPage';

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />

      {/* Protected — AppLayout handles auth redirect */}
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/rfqs" replace />} />
        <Route path="/rfqs" element={<RFQListPage />} />
        <Route path="/rfqs/:id" element={<RFQDetailPage />} />
        <Route path="/approval" element={<ApprovalPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

