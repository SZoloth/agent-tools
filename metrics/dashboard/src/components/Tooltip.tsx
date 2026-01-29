import { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

interface Props {
  content: string;
  children?: ReactNode;
  showIcon?: boolean;
}

export function Tooltip({ content, children, showIcon = true }: Props) {
  return (
    <span className="relative inline-flex items-center group">
      {children}
      {showIcon && (
        <HelpCircle
          className="w-4 h-4 text-slate-500 hover:text-slate-300 cursor-help ml-1"
          aria-label={content}
        />
      )}
      <span
        className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-sm text-slate-200 bg-slate-700 rounded-lg shadow-lg whitespace-normal w-64 text-left opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity duration-200 pointer-events-none"
        role="tooltip"
      >
        {content}
        <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-700" />
      </span>
    </span>
  );
}
