import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-gray-700 leading-5">
          {label}
        </label>
      )}
      <input
        id={id}
        {...props}
        className={[
          'block w-full h-9 rounded-md border px-3 py-1.5 text-sm text-gray-900',
          'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500',
          'disabled:bg-gray-50 disabled:text-gray-500',
          'transition-colors duration-150',
          error
            ? 'border-red-400 bg-red-50'
            : 'border-gray-300 bg-white',
          className,
        ].join(' ')}
      />
      {error && <p className="text-xs text-red-600 leading-4">{error}</p>}
    </div>
  );
}

