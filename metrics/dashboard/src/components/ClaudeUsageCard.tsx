import { Bot, Zap, FileCode, Star } from 'lucide-react';
import type { MetricsStore } from '../types';
import { Tooltip } from './Tooltip';

interface Props {
  metricsStore: MetricsStore | null;
}

export function ClaudeUsageCard({ metricsStore }: Props) {
  const claude = metricsStore?.claude_usage || {};
  const totalSessions = claude.total_sessions || 0;
  const taskTypes = claude.task_types || {};
  const avgQuality = claude.avg_quality_score || 0;
  const filesModified = claude.files_modified_count || 0;

  const sortedTaskTypes = Object.entries(taskTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const totalTasks = Object.values(taskTypes).reduce((a, b) => a + b, 0);

  const getTaskTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      coding: 'bg-blue-500',
      writing: 'bg-green-500',
      research: 'bg-yellow-500',
      planning: 'bg-purple-500',
      automation: 'bg-cyan-500',
      debugging: 'bg-red-500',
      data_analysis: 'bg-orange-500',
      job_search: 'bg-pink-500',
      personal: 'bg-slate-500',
    };
    return colors[type] || 'bg-slate-500';
  };

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <Bot className="w-5 h-5 text-cyan-400" />
        <h2 className="text-lg font-semibold">Claude Code Usage</h2>
        <Tooltip content="Analyzed from diary entries in ~/.claude/memory/diary/. Task types are detected via keyword matching in session content." />
      </div>

      {/* Key Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-slate-700/50 rounded-lg p-3 text-center group relative">
          <Zap className="w-5 h-5 text-yellow-400 mx-auto mb-1" />
          <div className="text-xl font-bold">{totalSessions}</div>
          <div className="text-xs text-slate-400 flex items-center justify-center gap-1">
            Sessions
            <Tooltip content="Total Claude Code sessions from diary entries. Each diary file represents one session." showIcon={true} />
          </div>
        </div>

        <div className="bg-slate-700/50 rounded-lg p-3 text-center">
          <Star className="w-5 h-5 text-amber-400 mx-auto mb-1" />
          <div className="text-xl font-bold">{avgQuality}</div>
          <div className="text-xs text-slate-400 flex items-center justify-center gap-1">
            Avg Quality
            <Tooltip content="Quality score (0-20) based on session depth: file reads (+2), edits (+3), tool usage (+2), multi-file changes (+3). Higher = more substantial sessions." showIcon={true} />
          </div>
        </div>

        <div className="bg-slate-700/50 rounded-lg p-3 text-center">
          <FileCode className="w-5 h-5 text-blue-400 mx-auto mb-1" />
          <div className="text-xl font-bold">{filesModified}</div>
          <div className="text-xs text-slate-400 flex items-center justify-center gap-1">
            Files
            <Tooltip content="Count of unique files modified across all sessions. Extracted from Edit/Write tool calls in diary entries." showIcon={true} />
          </div>
        </div>
      </div>

      {/* Task Type Breakdown */}
      {sortedTaskTypes.length > 0 && (
        <div>
          <h3 className="text-sm text-slate-400 mb-3 flex items-center gap-1">
            What You Use Claude For
            <Tooltip content="Task categories detected via keywords: coding (code, script, function), writing (draft, document), research (search, explore), planning (plan, design), automation (automate, script), debugging (bug, fix, error), etc." />
          </h3>
          <div className="space-y-3">
            {sortedTaskTypes.map(([type, count]) => {
              const pct = totalTasks > 0 ? Math.round((count / totalTasks) * 100) : 0;
              return (
                <div key={type}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="capitalize">{type.replace('_', ' ')}</span>
                    <span className="text-slate-400">{pct}%</span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${getTaskTypeColor(type)}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {totalSessions === 0 && (
        <div className="text-center py-8 text-slate-500">
          <p>No data yet</p>
          <p className="text-sm mt-1">Run <code>claude-stats.js --export</code></p>
        </div>
      )}
    </div>
  );
}
