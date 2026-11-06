import React from 'react';

type BadgeVariant = 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'gray';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-700',
  blue:    'bg-blue-100 text-blue-700',
  green:   'bg-green-100 text-green-700',
  yellow:  'bg-amber-100 text-amber-700',
  red:     'bg-red-100 text-red-700',
  gray:    'bg-gray-100 text-gray-500',
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
        variantClasses[variant],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}

