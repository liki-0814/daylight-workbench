export function getTrayState(state, day) {
  const pending = state.tasks.filter(task => task.status !== 'done');
  const ids = state.plans[day] || [];
  const today = ids.map(id => pending.find(task => task.id === id)).filter(Boolean);
  const other = pending.filter(task => !ids.includes(task.id));
  return { pending, today, other, title: `待办 ${pending.length}`, active: pending.find(task => task.status === 'active') };
}
