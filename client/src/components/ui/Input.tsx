import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-gray-700">
          {label}
        </label>
      )}
      <input
        id={id}
        {...props}
        className={[
          'block w-full rounded border px-3 py-2 text-sm',
          'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500',
          'disabled:bg-gray-50 disabled:text-gray-500',
          'transition-colors duration-150',
          error
            ? 'border-red-400 bg-red-50'
            : 'border-gray-300 bg-white',
          className,
        ].join(' ')}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

