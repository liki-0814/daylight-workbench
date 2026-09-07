// Synthetic test data only; never included in the application bundle.
export function fixtureState() {
  return {
    schema: 1,
    projects: [
      { id: 'project-a', name: '测试项目 A', path: '/tmp/project-a', color: 'green' },
      { id: 'project-b', name: '测试项目 B', path: '/tmp/project-b', color: 'amber' },
    ],
    tasks: Array.from({ length: 8 }, (_, i) => ({
      id: `task-${i + 1}`, projectId: i < 6 ? 'project-a' : 'project-b',
      title: `测试任务 ${i + 1}`, notes: '', status: 'todo', completedAt: null,
    })),
    plans: {},
  };
}
