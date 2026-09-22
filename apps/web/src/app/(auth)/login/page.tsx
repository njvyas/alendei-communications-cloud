'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, authApi } from '@/lib/api-client';
import { bootstrapSession, useSession } from '@/lib/session-store';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export default function LoginPage() {
  const router = useRouter();
  const status = useSession((state) => state.status);
  const setSession = useSession((state) => state.setSession);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rateLimitSeconds, setRateLimitSeconds] = useState<number | null>(null);

  // If already authenticated and ready or selecting organization, navigate to console
  useEffect(() => {
    if (status === 'idle') {
      void bootstrapSession();
    } else if (status === 'ready' || status === 'selecting_organization' || status === 'zero_organizations') {
      router.replace('/');
    }
  }, [status, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setRateLimitSeconds(null);

    try {
      // 1. Authenticate with credentials
      const loginRes = await authApi.login({ email, password });
      const accessToken = loginRes.data.accessToken;

      // 2. Fetch current identity and grants
      const [meRes, authRes] = await Promise.all([authApi.me(), authApi.authorization()]);

      // 3. Establish session and organization state
      setSession({
        accessToken,
        user: meRes.data,
        authorization: authRes.data,
      });

      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          const retryAfter = (err.details?.retryAfterSeconds as number) ?? 60;
          setRateLimitSeconds(retryAfter);
          setErrorMessage(`Too many sign-in attempts. Please wait ${retryAfter} seconds before trying again.`);
        } else if (err.code === 'AUTH_INVALID_CREDENTIALS') {
          setErrorMessage('Invalid email or password.');
        } else if (err.code === 'AUTH_ACCOUNT_DISABLED') {
          setErrorMessage('This account has been disabled. Please contact your administrator.');
        } else {
          setErrorMessage(err.message || 'Authentication failed. Please check your credentials.');
        }
      } else {
        setErrorMessage('An unexpected network error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <Card className="w-full">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
            Alendei Communications Cloud
          </p>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Enter your email and password to access the control plane.</CardDescription>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
          >
            {errorMessage}
            {rateLimitSeconds && (
              <p className="mt-1 font-mono text-[11px] opacity-80">
                Rate limited — Retry-After: {rateLimitSeconds}s
              </p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs font-medium text-[var(--color-ink-muted)]">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={isSubmitting}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder-[var(--color-ink-muted)]/50 focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-[var(--color-ink-muted)]">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={isSubmitting}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder-[var(--color-ink-muted)]/50 focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 flex w-full justify-center rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </Card>
    </div>
  );
}
