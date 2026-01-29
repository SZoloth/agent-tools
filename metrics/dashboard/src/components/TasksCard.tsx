import { CheckSquare, TrendingUp, TrendingDown } from 'lucide-react';
import type { MetricsStore } from '../types';
import { Tooltip } from './Tooltip';

interface Props {
  metricsStore: MetricsStore | null;
}

export function TasksCard({ metricsStore }: Props) {
  const things = metricsStore?.things || {};
  const categories = things.category_breakdown || {};
  const outcomeRatio = things.outcome_ratio || 0;
  const adminRatio = things.admin_ratio || 0;
  const totalCompleted = things.total_completed || 0;

  const sortedCategories = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const getCategoryIcon = (cat: string) => {
    const icons: Record<string, string> = {
      shipped: '🚀',
      needle_mover: '🎯',
      job_search: '💼',
      work: '💻',
      health: '💪',
      admin: '📋',
      personal: '🏠',
      uncategorized: '❓',
      priority_high: '🔴',
    };
    return icons[cat] || '•';
  };

  const isHealthy = outcomeRatio >= 60;

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <CheckSquare className="w-5 h-5 text-purple-400" />
        <h2 className="text-lg font-semibold">Task Outcomes</h2>
        <Tooltip content="From Things 3 logbook. Tasks are categorized by tags or keyword inference. Add 'Shipped' or 'Needle-mover' tags to track outcome work." />
      </div>

      {/* Outcome vs Admin Ratio */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className={`rounded-lg p-4 ${isHealthy ? 'bg-green-500/20' : 'bg-orange-500/20'}`}>
          <div className="flex items-center gap-2 mb-1">
            {isHealthy ? (
              <TrendingUp className="w-4 h-4 text-green-400" />
            ) : (
              <TrendingDown className="w-4 h-4 text-orange-400" />
            )}
            <span className="text-sm text-slate-300">Outcome Work</span>
            <Tooltip content="Tasks tagged 'Shipped' or 'Needle-mover'. These are high-impact tasks that move the needle on goals vs routine maintenance." />
          </div>
          <div className={`text-2xl font-bold ${isHealthy ? 'text-green-400' : 'text-orange-400'}`}>
            {outcomeRatio}%
          </div>
          <div className="text-xs text-slate-500">Target: 60%+</div>
        </div>

        <div className="bg-slate-700/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm text-slate-300">Maintenance</span>
            <Tooltip content="Tasks tagged 'Admin' or inferred admin work (emails, scheduling, chores). Low ratio = more strategic work." />
          </div>
          <div className="text-2xl font-bold text-slate-400">{adminRatio}%</div>
          <div className="text-xs text-slate-500">Target: &lt;40%</div>
        </div>
      </div>

      {/* Completed Count */}
      <div className="text-center mb-4 py-3 bg-slate-700/30 rounded-lg">
        <div className="text-3xl font-bold">{totalCompleted}</div>
        <div className="text-sm text-slate-400">tasks completed this period</div>
      </div>

      {/* Category Breakdown */}
      {sortedCategories.length > 0 && (
        <div>
          <h3 className="text-sm text-slate-400 mb-3">By Category</h3>
          <div className="space-y-2">
            {sortedCategories.map(([category, count]) => {
              const total = Object.values(categories).reduce((a, b) => a + b, 0);
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={category} className="flex items-center gap-2">
                  <span className="w-6 text-center">{getCategoryIcon(category)}</span>
                  <span className="text-sm flex-1 truncate">{category.replace('_', ' ')}</span>
                  <div className="w-24 bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-purple-500 h-2 rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm text-slate-500 w-12 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
