import React from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 focus:ring-brand-500 disabled:bg-brand-200',
  secondary:
    'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:ring-gray-400',
  danger:
    'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  ghost:
    'text-gray-600 hover:bg-gray-100 focus:ring-gray-400',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-2.5 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled ?? loading}
      className={[
        'inline-flex items-center justify-center gap-2 font-medium rounded',
        'focus:outline-none focus:ring-2 focus:ring-offset-1',
        'transition-colors duration-150',
        'disabled:opacity-60 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(' ')}
    >
      {loading && (
        <Loader2 className="animate-spin h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

