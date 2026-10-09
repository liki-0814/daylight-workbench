import { focusError, validateFocusQuery } from './focus-contracts.js';

const emptyMetrics = () => ({ workElapsedMs: 0, breakElapsedMs: 0, completedRounds: 0, stoppedSessions: 0, interruptedSessions: 0, includesCurrent: false });
const matches = (session, selection) => (!selection.taskId || session.taskId === selection.taskId) && (!selection.projectId || session.projectIdSnapshot === selection.projectId) && (!(selection.unassigned === '1' || selection.unassigned === true) || session.projectIdSnapshot === null) && (!selection.phase || session.phase === selection.phase);
const endpoint = (session, segment, now) => segment.endAt ?? Math.min(now, session.deadlineAt);
const countMetric = session => session.endReason === 'completed' ? 'completedRounds' : session.endReason === 'stopped' ? 'stoppedSessions' : 'interruptedSessions';
const brief = session => ({ ...session, segments: session.segments.map(segment => ({ ...segment })) });
const records = record => record.current ? [...record.sessions, record.current] : record.sessions;

// Binary lookup plus only the days a segment actually crosses avoids days × all records.
function firstWindow(windows, time) {
  let lo = 0, hi = windows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (windows[mid].endAt <= time) lo = mid + 1; else hi = mid; }
  return lo;
}

export function focusStatistics(record, selection, { now, dayWindows = [] } = {}) {
  selection = validateFocusQuery('statistics', selection);
  const daily = dayWindows.map(window => ({ day: window.day, ...emptyMetrics() }));
  const windows = dayWindows.map((window, i) => ({ ...window, i })).filter(window => window.exists !== false && window.endAt > window.startAt);
  const summary = emptyMetrics(), projects = new Map();
  for (const session of records(record)) {
    if (!matches(session, selection)) continue;
    const key = session.projectIdSnapshot ?? null;
    const project = projects.get(key) || { projectId: key, name: session.projectNameSnapshot ?? '未归类', ...emptyMetrics() };
    let included = false;
    for (const segment of session.segments) {
      const end = endpoint(session, segment, now);
      for (let w = firstWindow(windows, segment.startAt); w < windows.length && windows[w].startAt < end; w++) {
        const window = windows[w], amount = Math.max(0, Math.min(end, window.endAt) - Math.max(segment.startAt, window.startAt));
        if (!amount) continue;
        const metric = session.phase === 'work' ? 'workElapsedMs' : 'breakElapsedMs';
        summary[metric] += amount; project[metric] += amount; daily[window.i][metric] += amount; included = true;
        if (session.status !== 'ended' && session.phase === 'work') { summary.includesCurrent = true; project.includesCurrent = true; daily[window.i].includesCurrent = true; }
      }
    }
    if (session.status === 'ended' && session.phase === 'work') {
      const index = firstWindow(windows, session.endedAt), window = windows[index];
      if (window && session.endedAt >= window.startAt && session.endedAt < window.endAt) { const metric = countMetric(session); summary[metric]++; project[metric]++; daily[window.i][metric]++; included = true; }
    }
    if (included) projects.set(key, project);
  }
  return { version: record.version, asOf: now, serverNow: now, timeZone: record.settings.statisticsTimeZone, selection, summary, daily, projects: [...projects.values()].sort((a, b) => b.workElapsedMs - a.workElapsedMs || String(a.projectId).localeCompare(String(b.projectId))) };
}

export function focusTaskSummary(record, taskId, { now, recentLimit = 5 } = {}) {
  validateFocusQuery('task-summary', { taskId, recentLimit });
  const summary = emptyMetrics(), recent = [];
  for (const session of records(record)) {
    if (session.taskId !== taskId || session.phase !== 'work') continue;
    for (const segment of session.segments) summary.workElapsedMs += Math.max(0, endpoint(session, segment, now) - segment.startAt);
    if (session.status === 'ended') summary[countMetric(session)]++;
    else summary.includesCurrent = true;
    recent.push(session);
  }
  recent.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  return { version: record.version, asOf: now, serverNow: now, taskId, summary, recent: recent.slice(0, recentLimit).map(brief) };
}

export function focusSessionQuery(record, selection, { now, dayWindows = [] } = {}) {
  selection = validateFocusQuery('sessions', selection);
  const { cursor, limit, ...filter } = selection;
  const filterText = JSON.stringify(Object.keys(filter).sort().map(key => [key, filter[key]]));
  let offset = 0;
  if (cursor) {
    let value; try { value = JSON.parse(decodeURIComponent(cursor)); } catch { throw focusError('cursor 无效'); }
    if (value.version !== record.version) throw focusError('统计记录已变化，请从第一页重新查询', 'CURSOR_STALE', 409);
    if (value.filter !== filterText || !Number.isInteger(value.offset) || value.offset < 0) throw focusError('cursor 与筛选不匹配');
    offset = value.offset;
  }
  const windows = dayWindows.filter(window => window.exists !== false && window.endAt > window.startAt);
  const inRange = session => {
    if (!selection.from) return true;
    if (session.status === 'ended') { const window = windows[firstWindow(windows, session.endedAt)]; if (window && session.endedAt >= window.startAt && session.endedAt < window.endAt) return true; }
    return session.segments.some(segment => { const window = windows[firstWindow(windows, segment.startAt)]; return window && window.startAt < endpoint(session, segment, now); });
  };
  const selected = records(record).filter(session => matches(session, selection) && inRange(session));
  selected.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  const makeCursor = value => encodeURIComponent(JSON.stringify({ version: record.version, filter: filterText, offset: value }));
  return { version: record.version, asOf: now, serverNow: now, timeZone: record.settings.statisticsTimeZone, selection: filter, selectionRule: 'running interval intersects range or end point falls within range', sessions: selected.slice(offset, offset + limit).map(brief), total: selected.length, hasPrevious: offset > 0, hasNext: offset + limit < selected.length, previousCursor: offset > 0 ? makeCursor(Math.max(0, offset - limit)) : null, nextCursor: offset + limit < selected.length ? makeCursor(offset + limit) : null };
}
