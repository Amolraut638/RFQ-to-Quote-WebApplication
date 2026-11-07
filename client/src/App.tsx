import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { RFQListPage } from './pages/RFQListPage';
import { RFQDetailPage } from './pages/RFQDetailPage';
import { ApprovalPage } from './pages/ApprovalPage';
import { QuoteReviewPage } from './pages/QuoteReviewPage';
import { PartCostingPage } from './pages/PartCostingPage';
import { CostingResultsPage } from './pages/CostingResultsPage';

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
        <Route path="/rfqs/:rfqId/parts/:partId/costing" element={<PartCostingPage />} />
        <Route path="/rfqs/:rfqId/parts/:partId/results" element={<CostingResultsPage />} />
        <Route path="/approval" element={<ApprovalPage />} />
        <Route path="/approvals/:quoteId" element={<QuoteReviewPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
