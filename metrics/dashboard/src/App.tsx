import { useState, useEffect } from 'react';
import { HealthScoreCard } from './components/HealthScoreCard';
import { OutreachCard } from './components/OutreachCard';
import { ClaudeUsageCard } from './components/ClaudeUsageCard';
import { DeliverablesCard } from './components/DeliverablesCard';
import { TasksCard } from './components/TasksCard';
import type { OutreachLog, DeliverablesData, MetricsStore } from './types';
import { RefreshCw } from 'lucide-react';

function App() {
  const [outreachLog, setOutreachLog] = useState<OutreachLog | null>(null);
  const [deliverables, setDeliverables] = useState<DeliverablesData | null>(null);
  const [metricsStore, setMetricsStore] = useState<MetricsStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const loadData = async () => {
    setLoading(true);
    try {
      const [outreachRes, deliverablesRes, metricsRes] = await Promise.all([
        fetch('/data/outreach-log.json'),
        fetch('/data/deliverables.json'),
        fetch('/data/metrics-store.json'),
      ]);

      if (outreachRes.ok) setOutreachLog(await outreachRes.json());
      if (deliverablesRes.ok) setDeliverables(await deliverablesRes.json());
      if (metricsRes.ok) setMetricsStore(await metricsRes.json());
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error loading data:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const getWeekStart = () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const weekStart = new Date(now);
    weekStart.setDate(diff);
    return weekStart.toISOString().split('T')[0];
  };

  const calculateHealthScore = () => {
    let score = 0;
    const maxScore = 100;

    const weekStart = getWeekStart();
    const outreachThisWeek = outreachLog?.outreaches.filter(o => o.weekStart === weekStart).length || 0;
    score += Math.min(30, outreachThisWeek * 3);

    const tasksCompleted = metricsStore?.things?.total_completed || 0;
    score += Math.min(20, tasksCompleted);

    const sessions = metricsStore?.claude_usage?.total_sessions || 0;
    score += Math.min(10, sessions > 10 ? 10 : sessions);

    const thisMonth = new Date().toISOString().slice(0, 7);
    const deliverableCount = deliverables?.deliverables.filter(d =>
      d.date?.startsWith(thisMonth)
    ).length || 0;
    score += Math.min(20, deliverableCount * 5);

    const interviews = outreachLog?.interviews.length || 0;
    const pending = outreachLog?.outreaches.filter(o => o.status === 'sent').length || 0;
    score += Math.min(20, interviews * 10 + pending * 2);

    return { score, maxScore, percentage: Math.round((score / maxScore) * 100) };
  };

  const healthScore = calculateHealthScore();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-slate-400 text-lg">Loading metrics...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white">Impact Dashboard</h1>
            <p className="text-slate-400 mt-1">Week of {getWeekStart()}</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
            <button
              onClick={loadData}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-6">
          <HealthScoreCard healthScore={healthScore} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <OutreachCard outreachLog={outreachLog} weekStart={getWeekStart()} />
          <TasksCard metricsStore={metricsStore} />
          <ClaudeUsageCard metricsStore={metricsStore} />
          <DeliverablesCard deliverables={deliverables} />
        </div>

        <div className="mt-8 text-center text-slate-500 text-sm">
          <p>Run <code className="bg-slate-800 px-2 py-1 rounded">impact.js --export</code> to update data</p>
        </div>
      </div>
    </div>
  );
}

export default App;
