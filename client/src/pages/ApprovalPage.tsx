import { useAuth } from '../context/AuthContext';

export function ApprovalPage() {
  const { user } = useAuth();
  if (user?.role !== 'SALES_HEAD') {
    return <p className="text-sm text-red-600">Access denied. Sales Head only.</p>;
  }
  return (
    <div>
      <h1 className="text-lg font-semibold text-gray-900">Approvals</h1>
      <p className="mt-2 text-sm text-gray-500">Quotes pending approval — implemented in Day 4.</p>
    </div>
  );
}

