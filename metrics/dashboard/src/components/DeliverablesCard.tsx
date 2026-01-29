import { Package, Folder, User } from 'lucide-react';
import type { DeliverablesData, Deliverable } from '../types';
import { Tooltip } from './Tooltip';

interface Props {
  deliverables: DeliverablesData | null;
}

export function DeliverablesCard({ deliverables }: Props) {
  const items = deliverables?.deliverables || [];
  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthItems = items.filter(d => d.date?.startsWith(thisMonth));

  // Group by project
  const byProject: Record<string, number> = {};
  items.forEach(d => {
    byProject[d.project] = (byProject[d.project] || 0) + 1;
  });
  const topProjects = Object.entries(byProject)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  // Group by type
  const byType: Record<string, number> = {};
  items.forEach(d => {
    byType[d.typeName || d.type] = (byType[d.typeName || d.type] || 0) + 1;
  });

  const getTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      'Research & Analysis': '🔍',
      'Strategy Document': '📊',
      'Design Artifact': '🎨',
      'Prototype/POC': '🧪',
      'Presentation': '📽️',
      'Product Spec': '📋',
      'Process/Framework': '⚙️',
      'Workshop/Facilitation': '👥',
    };
    return icons[type] || '📄';
  };

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <Package className="w-5 h-5 text-amber-400" />
        <h2 className="text-lg font-semibold">Work Deliverables</h2>
        <Tooltip content="Track portfolio evidence with deliverables.js. Types: research, strategy, design, prototype, presentation, spec, process. Log with: deliverables.js log 'Title' 'Project' 'Stakeholder'" />
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-amber-500/20 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-amber-400">{thisMonthItems.length}</div>
          <div className="text-sm text-slate-400">This Month</div>
        </div>
        <div className="bg-slate-700/50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold">{items.length}</div>
          <div className="text-sm text-slate-400">All Time</div>
        </div>
      </div>

      {/* By Project */}
      {topProjects.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm text-slate-400 mb-2 flex items-center gap-2">
            <Folder className="w-4 h-4" />
            By Project
          </h3>
          <div className="space-y-1">
            {topProjects.map(([project, count]) => (
              <div key={project} className="flex justify-between text-sm">
                <span className="truncate">{project}</span>
                <span className="text-slate-500">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Deliverables */}
      {items.length > 0 && (
        <div>
          <h3 className="text-sm text-slate-400 mb-2">Recent</h3>
          <div className="space-y-2">
            {items.slice(-5).reverse().map((d) => (
              <div key={d.id} className="bg-slate-700/30 rounded p-2">
                <div className="flex items-start gap-2">
                  <span>{getTypeIcon(d.typeName || d.type)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{d.title}</div>
                    <div className="text-xs text-slate-500 flex items-center gap-2">
                      <span>{d.project}</span>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {d.stakeholder}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {items.length === 0 && (
        <div className="text-center py-8 text-slate-500">
          <p>No deliverables logged</p>
          <p className="text-sm mt-1">Run <code>deliverables.js log "Title" "Project" "Stakeholder"</code></p>
        </div>
      )}
    </div>
  );
}
