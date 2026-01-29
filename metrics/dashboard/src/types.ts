export interface OutreachEntry {
  id: number;
  company: string;
  contact: string;
  method: string;
  date: string;
  weekStart: string;
  status: string;
  followUpDue: string;
  responseDate?: string;
}

export interface OutreachLog {
  outreaches: OutreachEntry[];
  responses: { company: string; status: string; date: string }[];
  interviews: { company: string; contact: string; outreachDate: string; interviewDate: string }[];
}

export interface Deliverable {
  id: number;
  title: string;
  project: string;
  stakeholder: string;
  type: string;
  typeName: string;
  date: string;
  quarter: string;
}

export interface DeliverablesData {
  deliverables: Deliverable[];
}

export interface MetricsStore {
  version: string;
  last_updated: string | null;
  things: {
    last_analyzed?: string;
    period_weeks?: number;
    total_completed?: number;
    category_breakdown?: Record<string, number>;
    outcome_ratio?: number;
    admin_ratio?: number;
  };
  outreach: {
    sent: OutreachEntry[];
    responses: any[];
    interviews: any[];
    weekly_counts: any[];
  };
  claude_usage: {
    last_analyzed?: string;
    sessions_by_date?: Record<string, number>;
    task_types?: Record<string, number>;
    total_sessions?: number;
    avg_quality_score?: number;
    files_modified_count?: number;
  };
  work_deliverables: {
    dwa: any[];
    other: any[];
  };
  strava: {
    weekly_summary: any[];
    activity_types: Record<string, number>;
  };
  streaks: {
    outreach: { current: number; best: number };
    shipped: { current: number; best: number };
    training: { current: number; best: number };
  };
}

export interface DashboardData {
  metricsStore: MetricsStore;
  outreachLog: OutreachLog;
  deliverables: DeliverablesData;
  healthScore: {
    score: number;
    maxScore: number;
    percentage: number;
  };
}
