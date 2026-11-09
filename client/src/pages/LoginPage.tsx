import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calculator } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/rfqs');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded bg-brand-600 mb-4">
            <Calculator className="w-5 h-5 text-white" strokeWidth={1.8} aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">RFQ-to-Quote</h1>
          <p className="mt-1 text-sm text-gray-500">Costing Application</p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-gray-200 rounded-lg px-8 py-8 shadow-sm"
        >
          <h2 className="text-base font-semibold text-gray-900 mb-6">Sign in to your account</h2>

          <div className="flex flex-col gap-4">
            <Input
              id="email"
              label="Email address"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="estimator@demo.com"
            />
            <Input
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="mt-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={loading}
            className="w-full mt-6"
          >
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}

