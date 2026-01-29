import { Activity } from 'lucide-react';
import { Tooltip } from './Tooltip';

interface Props {
  healthScore: {
    score: number;
    maxScore: number;
    percentage: number;
  };
}

export function HealthScoreCard({ healthScore }: Props) {
  const getScoreColor = (pct: number) => {
    if (pct >= 70) return 'text-green-400';
    if (pct >= 50) return 'text-yellow-400';
    if (pct >= 30) return 'text-orange-400';
    return 'text-red-400';
  };

  const getBarColor = (pct: number) => {
    if (pct >= 70) return 'bg-green-500';
    if (pct >= 50) return 'bg-yellow-500';
    if (pct >= 30) return 'bg-orange-500';
    return 'bg-red-500';
  };

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Activity className="w-6 h-6 text-slate-400" />
          <h2 className="text-xl font-semibold">Health Score</h2>
          <Tooltip content="Composite score based on: Weekly outreach (30pts max, 3pts each), Tasks completed (20pts), Claude sessions (10pts), Monthly deliverables (20pts, 5pts each), Pipeline activity (20pts from interviews + pending outreach)." />
        </div>
        <div className={`text-4xl font-bold ${getScoreColor(healthScore.percentage)}`}>
          {healthScore.percentage}%
        </div>
      </div>

      <div className="w-full bg-slate-700 rounded-full h-4 mb-4">
        <div
          className={`h-4 rounded-full transition-all duration-500 ${getBarColor(healthScore.percentage)}`}
          style={{ width: `${healthScore.percentage}%` }}
        />
      </div>

      <div className="flex justify-between text-sm text-slate-400">
        <span>{healthScore.score} / {healthScore.maxScore} points</span>
        <span>Target: 70%+</span>
      </div>

      <div className="mt-4 grid grid-cols-5 gap-2 text-xs text-center text-slate-500">
        <div>
          <div className="h-2 bg-red-500/30 rounded mb-1" />
          <span>0-29</span>
        </div>
        <div>
          <div className="h-2 bg-orange-500/30 rounded mb-1" />
          <span>30-49</span>
        </div>
        <div>
          <div className="h-2 bg-yellow-500/30 rounded mb-1" />
          <span>50-69</span>
        </div>
        <div>
          <div className="h-2 bg-green-500/30 rounded mb-1" />
          <span>70-89</span>
        </div>
        <div>
          <div className="h-2 bg-green-500/50 rounded mb-1" />
          <span>90+</span>
        </div>
      </div>
    </div>
  );
}
