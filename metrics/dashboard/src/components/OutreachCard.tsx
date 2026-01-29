import { Mail, Target, Clock, MessageSquare } from 'lucide-react';
import type { OutreachLog } from '../types';
import { Tooltip } from './Tooltip';

interface Props {
  outreachLog: OutreachLog | null;
  weekStart: string;
}

export function OutreachCard({ outreachLog, weekStart }: Props) {
  const thisWeek = outreachLog?.outreaches.filter(o => o.weekStart === weekStart) || [];
  const pending = outreachLog?.outreaches.filter(o => o.status === 'sent') || [];
  const total = outreachLog?.outreaches.length || 0;
  const responses = outreachLog?.responses.length || 0;
  const interviews = outreachLog?.interviews.length || 0;
  const responseRate = total > 0 ? Math.round((responses / total) * 100) : 0;

  const target = 10;
  const progress = Math.min(100, (thisWeek.length / target) * 100);

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <Mail className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold">Job Search Outreach</h2>
        <Tooltip content="Track job search activity with outreach.js. Log contacts: outreach.js log 'Company' 'Contact' 'email'. Weekly target is 10 outreaches based on Never Search Alone methodology." />
      </div>

      {/* Weekly Progress */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-slate-400">This Week</span>
          <span className="text-2xl font-bold">
            {thisWeek.length}<span className="text-slate-500 text-lg">/{target}</span>
          </span>
        </div>
        <div className="w-full bg-slate-700 rounded-full h-3">
          <div
            className={`h-3 rounded-full transition-all ${
              thisWeek.length >= target ? 'bg-green-500' : 'bg-blue-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-sm text-slate-500 mt-1">
          {thisWeek.length >= target
            ? 'Target hit!'
            : `${target - thisWeek.length} more to hit target`}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
            <Clock className="w-4 h-4" />
            <span>Pending</span>
            <Tooltip content="Outreach sent but no response yet. Update with: outreach.js response 'Company' 'replied|interviewed|rejected'" />
          </div>
          <div className="text-xl font-semibold">{pending.length}</div>
        </div>

        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
            <MessageSquare className="w-4 h-4" />
            <span>Responses</span>
            <Tooltip content="Any response received (positive, negative, or neutral). Good response rate is 10-20%." />
          </div>
          <div className="text-xl font-semibold">{responses}</div>
        </div>

        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
            <Target className="w-4 h-4" />
            <span>Interviews</span>
            <Tooltip content="Outreach that converted to interviews. The key success metric for job search." />
          </div>
          <div className="text-xl font-semibold text-green-400">{interviews}</div>
        </div>

        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
            <span>Response Rate</span>
            <Tooltip content="Responses / Total outreach. Industry average for cold outreach is 5-15%." />
          </div>
          <div className="text-xl font-semibold">{responseRate}%</div>
        </div>
      </div>

      {/* Recent Outreach */}
      {thisWeek.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm text-slate-400 mb-2">Recent</h3>
          <div className="space-y-2">
            {thisWeek.slice(0, 3).map((o) => (
              <div key={o.id} className="flex justify-between text-sm">
                <span>{o.company}</span>
                <span className="text-slate-500">{o.contact}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
