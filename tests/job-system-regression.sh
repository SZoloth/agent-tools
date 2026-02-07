#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/samuelz/agent-tools"
TMP_HOME="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

mkdir -p "$TMP_HOME/bin" "$TMP_HOME/agent-tools" "$TMP_HOME/.claude/state"
mkdir -p "$TMP_HOME/Documents/LLM CONTEXT/1 - personal/job_search/Applications"
mkdir -p "$TMP_HOME/Documents/LLM CONTEXT/1 - personal"

cat > "$TMP_HOME/bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
shift || true
counter_file="${HOME}/.bd-counter"
if [[ ! -f "$counter_file" ]]; then
  echo 100 > "$counter_file"
fi
next_id() {
  n=$(cat "$counter_file")
  n=$((n+1))
  echo "$n" > "$counter_file"
  echo "1 - personal-$n"
}
case "$cmd" in
  create)
    next_id
    ;;
  comment|close|show|list)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$TMP_HOME/bin/bd"

cat > "$TMP_HOME/agent-tools/job-research.js" <<'EOF'
#!/usr/bin/env node
console.log(JSON.stringify({
  researchedAt: "2026-02-07T00:00:00.000Z",
  company: {
    founded: "2018",
    funding: { stage: "Series C", amount: "$120M", date: "2025" },
    size: "201-500",
    hq: "San Francisco",
    description: "Regression test company"
  },
  leadership: { ceo: { name: "Test CEO", linkedin: "https://linkedin.com/in/test", recentPosts: [] } },
  hiringManager: { candidates: [], searchQuery: null },
  companyContent: { blogPosts: [], podcasts: [] },
  news: []
}, null, 2));
EOF
chmod +x "$TMP_HOME/agent-tools/job-research.js"

cat > "$TMP_HOME/.claude/state/job-listings-cache.json" <<'EOF'
{
  "version": "1.0",
  "listings": {
    "legacy-1": {
      "jobId": "legacy-1",
      "title": "Legacy Role",
      "company": "Legacy Co",
      "status": "application_folder_created",
      "applicationFolder": "09-legacy-co",
      "score": 82
    },
    "job-1": {
      "jobId": "job-1",
      "title": "Senior Product Manager",
      "company": "Acme Inc",
      "location": "Remote",
      "postedTime": "1 day ago",
      "jobUrl": "https://example.com/jobs/1",
      "status": "qualified",
      "score": 88,
      "scoreBreakdown": {
        "sweetSpot": { "category": "strategyOps" },
        "companyTier": { "tier": "target" },
        "roleLevel": { "level": "senior" }
      }
    }
  }
}
EOF

cat > "$TMP_HOME/.claude/state/cos-state.json" <<'EOF'
{
  "version": "1.0",
  "job_pipeline": {
    "pending_materials": [],
    "materials_ready": [],
    "submitted_applications": [],
    "pending_review": []
  }
}
EOF

HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-state-migrate.js" --json >/tmp/job_state_migrate_test.json

HOME="$TMP_HOME" node - <<'EOF'
const fs = require('fs');
const path = require('path');
const home = process.env.HOME;
const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/job-listings-cache.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/cos-state.json'), 'utf8'));
if (cache.listings['legacy-1'].status !== 'prepped') throw new Error('legacy status not normalized');
if (state.job_pipeline.pending_materials.length < 1) throw new Error('pipeline not backfilled from prepped listing');
if (!state.job_pipeline.pending_materials[0].queueId) throw new Error('pending entry missing queueId after migration');
console.log('PASS migration normalization');
EOF

HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-apply-prep.js" job-1 --json >/tmp/job_apply_prep_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-materials-ready.js" --job-id job-1 --channel generated --json >/tmp/job_materials_ready_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-submit.js" --job-id job-1 --channel LinkedIn --date 2026-01-01 --json >/tmp/job_submit_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-followup-sync.js" --days 7 --json >/tmp/job_followup_sync_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-daily.js" --no-fresh --no-scrape --no-qualify --prep-top 0 --days 7 --json >/tmp/job_daily_test.json

HOME="$TMP_HOME" node - <<'EOF'
const fs = require('fs');
const path = require('path');
const home = process.env.HOME;
const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/job-listings-cache.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/cos-state.json'), 'utf8'));
const appsDir = path.join(home, 'Documents/LLM CONTEXT/1 - personal/job_search/Applications');
const folders = fs.readdirSync(appsDir).filter((f) => /^\d+-/.test(f));
if (folders.length === 0) throw new Error('no application folder created');
const folder = folders[0];
const notes = fs.readFileSync(path.join(appsDir, folder, 'Application_Research_Notes.md'), 'utf8');
if (!notes.includes('## Tracking')) throw new Error('tracking section missing in notes');
if (state.job_pipeline.pending_materials.length !== 1) throw new Error('expected one legacy pending after lifecycle');
if (state.job_pipeline.materials_ready.length !== 0) throw new Error('materials_ready should be empty after submit');
if (state.job_pipeline.submitted_applications.length !== 1) throw new Error('submitted_applications should contain one entry');
const submitted = state.job_pipeline.submitted_applications[0];
if (!submitted.queueId) throw new Error('submitted application missing queueId');
if (!submitted.followupTaskId) throw new Error('followup task not created');
if (cache.listings['job-1'].status !== 'applied') throw new Error('listing status should be applied');
if (!cache.listings['job-1'].followupTaskId) throw new Error('listing followupTaskId missing');
console.log('PASS full lifecycle + followup sync');
EOF

HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-trigger.js" "https://www.linkedin.com/jobs/view/99999" --skip-beads --prep-top 0 --json >/tmp/job_trigger_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-backlog.js" --json >/tmp/job_backlog_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-autopilot.js" --backlog-only --json >/tmp/job_autopilot_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-next.js" --json >/tmp/job_next_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-decision.js" skip --json >/tmp/job_decision_skip_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-decision.js" approve --skip-beads --json >/tmp/job_decision_approve_test.json

HOME="$TMP_HOME" node - <<'EOF'
const fs = require('fs');
const path = require('path');
const home = process.env.HOME;
const trigger = JSON.parse(fs.readFileSync('/tmp/job_trigger_test.json', 'utf8'));
const backlog = JSON.parse(fs.readFileSync('/tmp/job_backlog_test.json', 'utf8'));
const autopilot = JSON.parse(fs.readFileSync('/tmp/job_autopilot_test.json', 'utf8'));
const next = JSON.parse(fs.readFileSync('/tmp/job_next_test.json', 'utf8'));
const skip = JSON.parse(fs.readFileSync('/tmp/job_decision_skip_test.json', 'utf8'));
const approve = JSON.parse(fs.readFileSync('/tmp/job_decision_approve_test.json', 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/cos-state.json'), 'utf8'));
if (!trigger.candidates.some((c) => c.jobId === 'li_99999')) throw new Error('trigger did not include explicit URL candidate');
if (backlog.summary.readyForHumanReview < 1) throw new Error('backlog should show at least one item ready for review');
if (!autopilot.ok) throw new Error('autopilot should return ok=true');
if (!Array.isArray(autopilot.nextActions) || autopilot.nextActions.length < 1) throw new Error('autopilot nextActions missing');
if (!next.hasItem || !next.packet?.queueId) throw new Error('job-next should return packet with queueId');
if (skip.decision !== 'skip') throw new Error('skip decision failed');
if (approve.decision !== 'approve') throw new Error('approve decision failed');
if (!approve.target?.queueId) throw new Error('approve target queueId missing');
if ((state.job_pipeline.submitted_applications || []).length < 2) throw new Error('approve should increase submitted applications');
console.log('PASS trigger + backlog automation');
EOF

HOME="$TMP_HOME" node - <<'EOF'
const fs = require('fs');
const path = require('path');
const home = process.env.HOME;
const cachePath = path.join(home, '.claude/state/job-listings-cache.json');
const statePath = path.join(home, '.claude/state/cos-state.json');
const appsDir = path.join(home, 'Documents/LLM CONTEXT/1 - personal/job_search/Applications');
const folderName = '99-review-co';
const folderPath = path.join(appsDir, folderName);
fs.mkdirSync(folderPath, { recursive: true });
fs.writeFileSync(path.join(folderPath, 'Cover_Letter_2026-02-07.md'), 'Sam Zoloth\\nsmzoloth@gmail.com\\nReview Co\\nStaff PM');
fs.writeFileSync(path.join(folderPath, 'Resume_review_co_staff_pm_2026-02-07.md'), '# Resume');

const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
cache.listings['review-1'] = {
  jobId: 'review-1',
  queueId: 'q_job_review_1',
  title: 'Staff Product Manager',
  company: 'Review Co',
  status: 'materials_ready',
  score: 90,
  applicationFolder: folderName
};
fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.job_pipeline.materials_ready.push({
  queueId: 'q_job_review_1',
  jobId: 'review-1',
  folderName,
  company: 'Review Co',
  title: 'Staff Product Manager',
  score: 90
});
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
EOF

HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-decision.js" revise "tighten value narrative" --queue-id q_job_review_1 --json >/tmp/job_decision_revise_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-materials-ready.js" --queue-id q_job_review_1 --skip-beads --json >/tmp/job_materials_ready_requeue_test.json
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" node "$ROOT/job-decision.js" reject "not a fit" --queue-id q_job_review_1 --json >/tmp/job_decision_reject_test.json

HOME="$TMP_HOME" node - <<'EOF'
const fs = require('fs');
const path = require('path');
const home = process.env.HOME;
const revise = JSON.parse(fs.readFileSync('/tmp/job_decision_revise_test.json', 'utf8'));
const reject = JSON.parse(fs.readFileSync('/tmp/job_decision_reject_test.json', 'utf8'));
const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/job-listings-cache.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/cos-state.json'), 'utf8'));
if (revise.decision !== 'revise') throw new Error('revise decision failed');
if ((revise.effects?.revise?.movedTo || '') !== 'pending_materials') throw new Error('revise should move entry to pending_materials');
if (reject.decision !== 'reject') throw new Error('reject decision failed');
if ((cache.listings['review-1'] || {}).status !== 'archived') throw new Error('reject should archive listing');
if (state.job_pipeline.pending_materials.some((e) => e.queueId === 'q_job_review_1')) throw new Error('reject should remove from pending queue');
if (state.job_pipeline.materials_ready.some((e) => e.queueId === 'q_job_review_1')) throw new Error('reject should remove from ready queue');
console.log('PASS revise + reject decisions');
EOF

echo "ALL REGRESSION TESTS PASSED"
