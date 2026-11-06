import { useParams, Link } from 'react-router-dom';

export function RFQDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div>
      <Link to="/rfqs" className="text-sm text-brand-600 hover:underline">← RFQ Register</Link>
      <h1 className="mt-4 text-lg font-semibold text-gray-900">RFQ Detail</h1>
      <p className="mt-2 text-sm text-gray-500">ID: {id}</p>
      <p className="mt-6 text-sm text-gray-400">Full RFQ detail view — implemented in Day 2.</p>
    </div>
  );
}

